// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { discountApprovalTtlMin, isUniqueViolation, newApprovalCode, parseRub, paymentMaxRub } from '@/lib/cash'

export const dynamic = 'force-dynamic'

// Одноразовый код подтверждения скидки сверх лимита роли (чек-лист P0 «Касса»).
// Выдаёт сотрудник с правом cash.discount_override (по умолчанию администратор) для конкретного пациента
// и максимальной суммы скидки; кассир вводит код при оплате. Выдача и использование — в аудите.
export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'cash.discount_override')
  if (!g.ok) return g.res
  try {
    const body = await req.json().catch(() => ({}))
    const patientId = typeof body.patientId === 'string' ? body.patientId : ''
    const maxDiscount = parseRub(body.maxDiscount, 1, paymentMaxRub())
    if (!patientId || maxDiscount === null) return NextResponse.json({ error: 'Укажите пациента и сумму скидки (целые рубли)' }, { status: 400 })
    const patient = await db.patient.findUnique({ where: { id: patientId }, select: { id: true, anonymizedAt: true } })
    if (!patient || patient.anonymizedAt) return NextResponse.json({ error: 'Пациент не найден' }, { status: 404 })
    const reason = String(body.reason || '').trim().slice(0, 200)
    if (reason.length < 3) return NextResponse.json({ error: 'Укажите основание скидки' }, { status: 400 })
    const expiresAt = new Date(Date.now() + discountApprovalTtlMin() * 60_000)
    for (let i = 0; i < 5; i++) {
      try {
        const ap = await db.discountApproval.create({ data: { code: newApprovalCode(), patientId, maxDiscount, reason, createdById: g.user.id, expiresAt } })
        await audit('payment.discount_approval_created', g.user.id, { approvalId: ap.id, patientId, maxDiscount })
        return NextResponse.json({ approval: { code: ap.code, maxDiscount, expiresAt: expiresAt.toISOString() } }, { status: 201 })
      } catch (e) {
        if (!isUniqueViolation(e)) throw e
      }
    }
    return NextResponse.json({ error: 'Не удалось выдать код, повторите' }, { status: 500 })
  } catch (e) {
    console.error('[payments/discount-approvals POST]', e)
    return NextResponse.json({ error: 'Не удалось выдать код подтверждения' }, { status: 500 })
  }
}
