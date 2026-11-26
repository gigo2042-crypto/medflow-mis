// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Очередь фискализации: отправка оплат/возвратов в облачную кассу и опрос результата.
// Серверный модуль — не импортировать в клиентский код!
import { db } from '@/lib/db'
import { isDemo } from '@/lib/config'
import { FiscalNotConfiguredError, fetchReport, fiscalStatus, sendReceipt } from '@/lib/fiscal'

function demoNumber(): string {
  return `ДЕМО ФН 9928-44 · ФД ${Math.floor(100000 + Math.random() * 899999)}`
}

function parseItems(json: string | null, amount: number, discount: number): Array<{ name: string; price: number; qty: number }> {
  try {
    const arr = json ? (JSON.parse(json) as Array<{ name: string; price: number; qty: number }>) : []
    if (Array.isArray(arr) && arr.length) return arr
  } catch {
    /* без состава */
  }
  return [{ name: 'Медицинская услуга', price: Math.abs(amount) + discount, qty: 1 }]
}

export class FiscalError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message)
  }
}

/** Отправить чек прихода (PAYMENT) или возврата прихода (REFUND) по оплате. */
export async function fiscalizePayment(paymentId: string, cashierName?: string | null) {
  const p = await db.payment.findUnique({ where: { id: paymentId }, include: { patient: true, refundOf: true } })
  if (!p) throw new FiscalError('Оплата не найдена', 'NOT_FOUND', 404)
  if (p.status === 'CANCELED' && p.type === 'PAYMENT' && p.fiscalStatus !== 'ISSUED') throw new FiscalError('Оплата отменена — чек не пробивается', 'CANCELED', 409)
  if (!['QUEUED', 'ERROR'].includes(p.fiscalStatus)) throw new FiscalError('Чек по оплате уже отправлен или выдан', 'ALREADY', 409)
  const st = fiscalStatus()
  if (!isDemo() && !st.configured) throw new FiscalError(st.problem || 'Онлайн-касса не настроена', 'FISCAL_NOT_CONFIGURED', 409)
  // Атомарный захват: два одновременных «Фискализировать» или фискализация параллельно с отменой
  // не отправят чек дважды и не пробьют отменённую оплату
  const claimed = await db.payment.updateMany({
    where: { id: p.id, fiscalStatus: { in: ['QUEUED', 'ERROR'] }, OR: [{ type: 'REFUND' }, { status: 'PAID' }] },
    data: { fiscalStatus: 'PENDING', fiscalError: null },
  })
  if (claimed.count !== 1) throw new FiscalError('Чек по оплате уже отправлен, выдан или оплата отменена', 'ALREADY', 409)
  if (isDemo()) {
    return db.payment.update({ where: { id: p.id }, data: { fiscalStatus: 'ISSUED', fiscalNumber: demoNumber(), fiscalAt: new Date(), fiscalError: null } })
  }
  // скидку берём из исходной оплаты (у возврата она та же)
  const discount = p.type === 'REFUND' ? p.refundOf?.discount ?? 0 : p.discount
  try {
    const r = await sendReceipt({
      externalId: p.id, // идемпотентность: повтор с тем же external_id не создаст второй чек
      operation: p.type === 'REFUND' ? 'sell_refund' : 'sell',
      items: parseItems(p.itemsJson, p.amount, discount),
      discount,
      method: p.method,
      client: { email: p.patient.email, phone: p.patient.phone },
      cashier: cashierName ?? null,
    })
    return db.payment.update({
      where: { id: p.id },
      data: r.state === 'PENDING' ? { fiscalStatus: 'PENDING', fiscalUuid: r.uuid, fiscalError: null } : { fiscalStatus: 'ERROR', fiscalError: r.error },
    })
  } catch (e) {
    if (e instanceof FiscalNotConfiguredError) throw new FiscalError(e.message, 'FISCAL_NOT_CONFIGURED', 409)
    const msg = (e as Error).message
    await db.payment.update({ where: { id: p.id }, data: { fiscalStatus: 'ERROR', fiscalError: msg.slice(0, 500) } })
    throw new FiscalError(`Касса: ${msg}`, 'FISCAL_SEND_FAILED', 502)
  }
}

/** Опрос результатов по отправленным чекам (планировщик, раз в минуту). */
export async function pollFiscal(limit = 50): Promise<{ checked: number; issued: number; failed: number }> {
  const res = { checked: 0, issued: 0, failed: 0 }
  if (isDemo() || !fiscalStatus().configured) return res
  const pending = await db.payment.findMany({ where: { fiscalStatus: 'PENDING', fiscalUuid: { not: null } }, orderBy: { createdAt: 'asc' }, take: limit })
  for (const p of pending) {
    res.checked++
    try {
      const r = await fetchReport(p.fiscalUuid!)
      if (r.state === 'ISSUED') {
        await db.payment.update({ where: { id: p.id }, data: { fiscalStatus: 'ISSUED', fiscalNumber: r.fiscalNumber, fiscalReceiptUrl: r.receiptUrl, fiscalAt: new Date(), fiscalError: null } })
        res.issued++
      } else if (r.state === 'ERROR') {
        await db.payment.update({ where: { id: p.id }, data: { fiscalStatus: 'ERROR', fiscalError: r.error } })
        res.failed++
      }
    } catch (e) {
      console.error('[fiscal poll]', (e as Error).message)
    }
  }
  return res
}
