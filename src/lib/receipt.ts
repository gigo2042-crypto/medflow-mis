// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Текст кассового чека для печати: перенос длинных наименований (вместо обрезки
// до 22 символов, чеклист п.12) и скидка отдельной строкой.
import type { PaymentDTO } from '@/lib/types'

export const RECEIPT_WIDTH = 40
const NAME_WIDTH = 22

/** Перенос строки по словам; слишком длинные слова режутся по ширине. */
export function wrapText(text: string, width: number): string[] {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (let w of words) {
    while (w.length > width) {
      if (cur) {
        lines.push(cur)
        cur = ''
      }
      lines.push(w.slice(0, width))
      w = w.slice(width)
    }
    if (!cur) cur = w
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`
    else {
      lines.push(cur)
      cur = w
    }
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : ['']
}

export function receiptItemLines(name: string, qty: number, price: number): string[] {
  const parts = wrapText(name, NAME_WIDTH)
  const tail = `${qty}x ${price} = ${price * qty}`
  const last = parts.pop() as string
  return [...parts, `${last.padEnd(NAME_WIDTH)} ${tail}`]
}

export function buildReceipt(
  p: Pick<PaymentDTO, 'fiscalNumber' | 'patientName' | 'cardNumber' | 'items' | 'amount' | 'discount' | 'method' | 'type' | 'createdByName'>,
  opts: { demo: boolean; clinicName: string; clinicInn?: string; dateLine: string; methodLabel: string }
): string {
  const lines: string[] = [
    opts.demo ? 'КАССОВЫЙ ЧЕК (ДЕМО, не фискальный)' : 'КОПИЯ ЧЕКА (фискальный чек — у ОФД)',
    opts.clinicName,
    ...(opts.clinicInn ? [`ИНН ${opts.clinicInn}`] : []),
    '',
    `Чек: ${p.fiscalNumber || 'ожидает фискализации'}`,
    `Дата: ${opts.dateLine}`,
    `Пациент: ${p.patientName} (${p.cardNumber})`,
    '',
    'НАИМЕНОВАНИЕ            КОЛ  ЦЕНА   СУММА',
    '-'.repeat(RECEIPT_WIDTH),
  ]
  const sign = p.type === 'REFUND' ? -1 : 1
  if (p.items && p.items.length) {
    for (const it of p.items) lines.push(...receiptItemLines(it.name, it.qty, it.price))
  } else {
    const gross = Math.abs(p.amount) + (p.discount || 0)
    lines.push(...receiptItemLines('Услуга (без номенклатуры)', 1, gross))
  }
  if (p.discount > 0) lines.push(`${'Скидка'.padEnd(NAME_WIDTH)} -${p.discount}`)
  lines.push(
    '-'.repeat(RECEIPT_WIDTH),
    `ИТОГ: ${sign * Math.abs(p.amount)} ₽`,
    `Способ: ${opts.methodLabel}`,
    p.type === 'REFUND' ? 'ВИД ОПЕРАЦИИ: ВОЗВРАТ ПРИХОДА' : 'ВИД ОПЕРАЦИИ: ПРИХОД',
    '',
    `Кассир: ${p.createdByName || '—'}`
  )
  return lines.join('\n')
}
