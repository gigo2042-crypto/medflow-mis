// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { isDemo } from '@/lib/config'
import { FiscalError, fiscalizePayment } from '@/lib/fiscal-queue'
import { fiscalStatus } from '@/lib/fiscal'

export const dynamic = 'force-dynamic'

// Действия кассира над оплатой: фискализация (54-ФЗ) и возврат (чек возврата)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { action } = await req.json()

    if (action === 'fiscalize') {
      const g = await requirePerm(req, 'cash.fiscalize')
      if (!g.ok) return g.res
      try {
        const updated = await fiscalizePayment(id, g.user.name)
        await audit('payment.fiscalized', g.user.id, { paymentId: id, fiscalStatus: updated.fiscalStatus, fiscalNumber: updated.fiscalNumber })
        return NextResponse.json({ payment: updated })
      } catch (e) {
        if (e instanceof FiscalError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
        throw e
      }
    }

    if (action === 'cancel') {
      // Отмена оплаты, по которой чек ещё не пробит (QUEUED/ERROR): чека нет — возвращать нечего,
      // оплата просто аннулируется и больше не уйдёт в кассу (54-ФЗ)
      const g = await requirePerm(req, 'cash.refund')
      if (!g.ok) return g.res
      const res = await db.payment.updateMany({
        where: { id, type: 'PAYMENT', status: 'PAID', fiscalStatus: { in: ['QUEUED', 'ERROR'] } },
        data: { status: 'CANCELED', fiscalStatus: 'CANCELED' },
      })
      if (res.count !== 1) {
        const p = await db.payment.findUnique({ where: { id }, select: { fiscalStatus: true, status: true, type: true } })
        if (!p) return NextResponse.json({ error: 'Оплата не найдена' }, { status: 404 })
        const why = p.status !== 'PAID' || p.type !== 'PAYMENT' ? 'оплата уже отменена или это возврат' : p.fiscalStatus === 'ISSUED' ? 'чек уже выдан — оформите возврат' : 'чек отправлен в кассу — дождитесь результата'
        return NextResponse.json({ error: `Отмена невозможна: ${why}` }, { status: 409 })
      }
      await audit('payment.canceled', g.user.id, { paymentId: id })
      return NextResponse.json({ payment: await db.payment.findUnique({ where: { id } }) })
    }

    if (action === 'refund') {
      const g = await requirePerm(req, 'cash.refund')
      if (!g.ok) return g.res
      const payment = await db.payment.findUnique({ where: { id }, include: { refunds: true } })
      if (!payment) return NextResponse.json({ error: 'Оплата не найдена' }, { status: 404 })
      if (payment.type !== 'PAYMENT' || payment.status !== 'PAID') {
        return NextResponse.json({ error: 'Возврат возможен только по действующей оплате' }, { status: 409 })
      }
      if (payment.refunds.length > 0) {
        return NextResponse.json({ error: 'Возврат по этой оплате уже оформлен' }, { status: 409 })
      }
      // Чек возврата прихода — только к пробитому чеку прихода (54-ФЗ)
      if (payment.fiscalStatus !== 'ISSUED') {
        const msg = payment.fiscalStatus === 'PENDING'
          ? 'Чек по оплате ещё в кассе — дождитесь результата, затем оформляйте возврат'
          : 'Чек по оплате не пробит — возврат невозможен. Отмените оплату (действие «Отменить»), она не уйдёт в кассу'
        return NextResponse.json({ error: msg, code: 'NOT_FISCALIZED' }, { status: 409 })
      }
      let refund
      try {
        refund = await db.$transaction(async (tx) => {
          // смена статуса и создание возврата — одной транзакцией; условие на статус — защита от гонки
          const upd = await tx.payment.updateMany({ where: { id, type: 'PAYMENT', status: 'PAID', fiscalStatus: 'ISSUED' }, data: { status: 'CANCELED' } })
          if (upd.count !== 1) throw new RefundRace()
          return tx.payment.create({
            data: {
              patientId: payment.patientId,
              visitId: payment.visitId,
              amount: -payment.amount,
              method: payment.method,
              type: 'REFUND',
              status: 'PAID',
              fiscalStatus: 'QUEUED',
              itemsJson: payment.itemsJson,
              note: `Возврат по оплате ${payment.id.slice(-8).toUpperCase()}`,
              refundOfId: payment.id,
              createdById: g.user.id,
            },
          })
        })
      } catch (e) {
        if (e instanceof RefundRace || (e as { code?: string }).code === 'P2002') {
          return NextResponse.json({ error: 'Возврат по этой оплате уже оформлен' }, { status: 409 })
        }
        throw e
      }
      await audit('payment.refunded', g.user.id, { paymentId: id, refundId: refund.id, amount: payment.amount })
      // Чек возврата прихода: сразу в кассу, если она настроена (в демо — имитация);
      // иначе возврат остаётся «не фискализирован» и касса показывает предупреждение
      let fiscalNote: string | null = null
      if (isDemo() || fiscalStatus().configured) {
        try {
          await fiscalizePayment(refund.id, g.user.name)
        } catch (e) {
          fiscalNote = (e as Error).message
        }
      } else {
        fiscalNote = fiscalStatus().problem
      }
      const fresh = await db.payment.findUnique({ where: { id: refund.id } })
      return NextResponse.json({ refund: fresh, fiscalNote }, { status: 201 })
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 })
  } catch (e) {
    console.error('[payments PATCH]', e)
    return NextResponse.json({ error: 'Не удалось выполнить операцию кассы' }, { status: 500 })
  }
}

class RefundRace extends Error {}
