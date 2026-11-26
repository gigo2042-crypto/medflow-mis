// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { hasPerm } from '@/lib/rbac'
import { discountLimit, discountMaxPercent, isUniqueViolation, normalizeApprovalCode, parseClientKey, parseRub, paymentMaxRub } from '@/lib/cash'
import { dayRangeOf, todayKey } from '@/lib/mis-utils'
import { PaymentDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'


function dayRange(dateParam: string | null): { gte: Date; lt: Date } {
  const r = dateParam ? dayRangeOf(dateParam) : null
  return r ?? dayRangeOf(todayKey())!
}

// Касса за день (ФТ-006): платежи + сводка (X-отчёт)
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'cash.read')
  if (!g.ok) return g.res
  try {
    const range = dayRange(req.nextUrl.searchParams.get('date'))
    const rows = await db.payment.findMany({
      where: { createdAt: range },
      include: {
        patient: { select: { lastName: true, firstName: true, cardNumber: true } },
        createdBy: { select: { name: true } },
        refunds: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
    const payments: PaymentDTO[] = rows.map((p) => ({
      id: p.id,
      patientId: p.patientId,
      patientName: `${p.patient.lastName} ${p.patient.firstName}`,
      cardNumber: p.patient.cardNumber,
      visitId: p.visitId,
      amount: p.amount,
      method: p.method,
      type: p.type,
      status: p.status, // нужен кассе для кнопки «Возврат» (чеклист п.12)
      refunded: p.refunds.length > 0,
      discount: p.discount,
      fiscalStatus: p.fiscalStatus,
      fiscalNumber: p.fiscalNumber,
      fiscalError: p.fiscalError,
      fiscalReceiptUrl: p.fiscalReceiptUrl,
      items: p.itemsJson ? JSON.parse(p.itemsJson) : null,
      note: p.note,
      createdByName: p.createdBy?.name || null,
      createdAt: p.createdAt.toISOString(),
    }))
    const byMethod: Record<string, number> = {}
    let gross = 0
    let refunds = 0
    let issued = 0
    let queued = 0
    for (const p of payments) {
      if (p.type === 'REFUND') {
        refunds += p.amount
        continue
      }
      gross += p.amount
      byMethod[p.method] = (byMethod[p.method] || 0) + p.amount
      if (p.fiscalStatus === 'ISSUED') issued++
      if (p.fiscalStatus === 'QUEUED') queued++
    }
    const summary = { gross, refunds, net: gross + refunds, byMethod, count: payments.filter((p) => p.type === 'PAYMENT').length, issued, queued }
    return NextResponse.json({ payments, summary })
  } catch (e) {
    console.error('[payments GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить кассу' }, { status: 500 })
  }
}

// Новая оплата: состав из прайс-листа либо произвольная сумма (ФТ-006)
// Оплата ставится в очередь фискализации 54-ФЗ (КП-015).
// Целостность (чек-лист P0 «Касса»): суммы — целые рубли в пределах PAYMENT_MAX_RUB; одна действующая
// оплата на приём (уникальный индекс) и ключ идемпотентности clientKey; скидка сверх DISCOUNT_MAX_PERCENT —
// только с правом cash.discount_override или по одноразовому коду администратора; всё — в аудит.
export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'cash.pay')
  if (!g.ok) return g.res
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 })
    const { patientId, visitId, items, amount, method, note, discount: discountRaw, discountApprovalCode } = body as Record<string, unknown>
    if (!patientId || typeof patientId !== 'string') return NextResponse.json({ error: 'Выберите пациента' }, { status: 400 })
    if (visitId !== undefined && visitId !== null && typeof visitId !== 'string') return NextResponse.json({ error: 'Некорректный приём' }, { status: 400 })
    const m = typeof method === 'string' && ['CASH', 'CARD', 'SBP'].includes(method) ? method : 'CARD'
    const clientKey = body.clientKey === undefined ? null : parseClientKey(body.clientKey)
    if (body.clientKey !== undefined && !clientKey) return NextResponse.json({ error: 'Некорректный ключ оплаты' }, { status: 400 })
    const MAX = paymentMaxRub()

    // Повтор того же запроса (двойной клик, повтор после обрыва связи) — вернуть уже созданную оплату
    if (clientKey) {
      const dup = await db.payment.findUnique({ where: { clientKey } })
      if (dup) {
        if (dup.patientId !== patientId) return NextResponse.json({ error: 'Ключ оплаты уже использован' }, { status: 409 })
        return NextResponse.json({ payment: dup, duplicate: true }, { status: 200 })
      }
    }

    const patient = await db.patient.findUnique({ where: { id: patientId } })
    if (!patient) return NextResponse.json({ error: 'Пациент не найден' }, { status: 404 })
    let visitService: { name: string; price: number } | null = null
    if (visitId) {
      const visit = await db.visit.findUnique({ where: { id: visitId }, include: { service: true } })
      if (!visit || visit.patientId !== patientId) {
        return NextResponse.json({ error: 'Приём не относится к выбранному пациенту' }, { status: 400 })
      }
      const active = await db.payment.findFirst({ where: { visitId, type: 'PAYMENT', status: 'PAID' }, select: { id: true } })
      if (active) return NextResponse.json({ error: 'По этому приёму уже есть действующая оплата', paymentId: active.id }, { status: 409 })
      if (visit.service) visitService = { name: visit.service.name, price: visit.service.price }
    }

    let total = 0
    let itemsJson: string | null = null
    if (Array.isArray(items) && items.length > 0) {
      if (items.length > 50) return NextResponse.json({ error: 'Слишком много позиций в чеке' }, { status: 400 })
      const ids = items.map((i: { serviceId?: unknown }) => String(i?.serviceId ?? ''))
      const services = await db.serviceItem.findMany({ where: { id: { in: ids } } })
      const map = new Map(services.map((s) => [s.id, s]))
      const composed: Array<{ name: string; price: number; qty: number }> = []
      for (const it of items as Array<{ serviceId?: unknown; qty?: unknown }>) {
        const s = map.get(String(it?.serviceId ?? ''))
        if (!s) return NextResponse.json({ error: 'Услуга из прайс-листа не найдена' }, { status: 400 })
        const qty = it.qty === undefined || it.qty === null ? 1 : parseRub(it.qty, 1, 100)
        if (qty === null) return NextResponse.json({ error: 'Количество — целое число от 1 до 100' }, { status: 400 })
        composed.push({ name: s.name, price: s.price, qty })
        total += s.price * qty
      }
      itemsJson = JSON.stringify(composed)
    } else if (visitService && amount === undefined) {
      // оплата приёма по умолчанию — услуга визита по цене прайса
      total = visitService.price
      itemsJson = JSON.stringify([{ name: visitService.name, price: visitService.price, qty: 1 }])
    } else {
      if (amount === undefined || amount === null) return NextResponse.json({ error: 'Выберите услуги или укажите сумму' }, { status: 400 })
      const a = parseRub(amount, 1, MAX)
      if (a === null) return NextResponse.json({ error: `Сумма — целое число рублей от 1 до ${MAX}` }, { status: 400 })
      total = a
    }
    if (!Number.isSafeInteger(total) || total <= 0) return NextResponse.json({ error: 'Сумма оплаты должна быть больше нуля' }, { status: 400 })
    if (total > MAX) return NextResponse.json({ error: `Сумма оплаты больше допустимой (${MAX} ₽)` }, { status: 400 })

    // Скидка — отдельной строкой чека, сумма к оплате = состав − скидка
    let discount = 0
    if (discountRaw !== undefined && discountRaw !== null && discountRaw !== 0) {
      const d = parseRub(discountRaw, 0, total - 1)
      if (d === null) return NextResponse.json({ error: 'Скидка — целое число рублей меньше суммы оплаты' }, { status: 400 })
      discount = d
    }
    const limit = discountLimit(total)
    const needsApproval = discount > limit && !hasPerm(g.user.role, 'cash.discount_override')
    const code = needsApproval ? normalizeApprovalCode(discountApprovalCode) : ''
    let approvalId: string | null = null
    if (needsApproval) {
      if (!code) {
        await audit('payment.discount_denied', g.user.id, { patientId, discount, limit, total })
        return NextResponse.json(
          { error: `Скидка больше ${discountMaxPercent()}% (${limit} ₽) — нужен код подтверждения администратора`, code: 'DISCOUNT_APPROVAL_REQUIRED', limit },
          { status: 403 }
        )
      }
      const ap = await db.discountApproval.findUnique({ where: { code } })
      if (!ap || ap.patientId !== patientId || ap.usedAt || ap.expiresAt.getTime() < Date.now() || ap.maxDiscount < discount) {
        await audit('payment.discount_denied', g.user.id, { patientId, discount, limit, total, approval: ap ? ap.id : null })
        return NextResponse.json({ error: 'Код подтверждения скидки недействителен, истёк, уже использован или выдан на меньшую скидку/другого пациента', code: 'DISCOUNT_APPROVAL_INVALID' }, { status: 403 })
      }
      approvalId = ap.id
    }
    const payable = total - discount

    let payment
    try {
      payment = await db.$transaction(async (tx) => {
        if (approvalId) {
          // код одноразовый: занимаем его атомарно
          const used = await tx.discountApproval.updateMany({
            where: { id: approvalId, usedAt: null, expiresAt: { gt: new Date() } },
            data: { usedAt: new Date(), usedById: g.user.id },
          })
          if (used.count !== 1) throw new ApprovalRace()
        }
        const created = await tx.payment.create({
          data: {
            patientId,
            visitId: visitId || undefined,
            amount: payable,
            discount,
            method: m,
            type: 'PAYMENT',
            status: 'PAID',
            fiscalStatus: 'QUEUED',
            itemsJson,
            note: note ? String(note).slice(0, 300) : undefined,
            createdById: g.user.id,
            clientKey,
            discountApprovalId: approvalId,
          },
        })
        if (approvalId) await tx.discountApproval.update({ where: { id: approvalId }, data: { paymentId: created.id } })
        return created
      })
    } catch (e) {
      if (e instanceof ApprovalRace) return NextResponse.json({ error: 'Код подтверждения скидки уже использован', code: 'DISCOUNT_APPROVAL_INVALID' }, { status: 409 })
      if (isUniqueViolation(e)) {
        // параллельный запрос успел первым: та же оплата по приёму или тот же ключ
        const existing = clientKey ? await db.payment.findUnique({ where: { clientKey } }) : null
        if (existing && existing.patientId === patientId) return NextResponse.json({ payment: existing, duplicate: true }, { status: 200 })
        return NextResponse.json({ error: 'По этому приёму уже есть действующая оплата' }, { status: 409 })
      }
      throw e
    }
    await audit('payment.created', g.user.id, { paymentId: payment.id, amount: payable, discount, method: m, patientId, discountApprovalId: approvalId, discountOverLimit: discount > limit })
    if (approvalId) await audit('payment.discount_approved', g.user.id, { paymentId: payment.id, approvalId, discount, limit })
    return NextResponse.json({ payment }, { status: 201 })
  } catch (e) {
    console.error('[payments POST]', e)
    return NextResponse.json({ error: 'Не удалось создать оплату' }, { status: 500 })
  }
}

class ApprovalRace extends Error {}
