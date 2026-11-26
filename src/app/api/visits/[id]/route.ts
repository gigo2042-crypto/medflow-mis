// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { consumeForVisit } from '@/lib/stock'
import { logEvent, integrationsSimulated } from '@/lib/integrations'
import { resolveIcd } from '@/lib/icd-db'
import { canEditVisitOf } from '@/lib/visit-access'
import { canTransition } from '@/lib/appointment-rules'

export const dynamic = 'force-dynamic'

// Сохранение протокола приёма. Правит только врач-владелец (или администратор),
// после завершения (DONE) протокол заблокирован; диагноз — только из справочника МКБ.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requirePerm(req, 'visits.write')
  if (!g.ok) return g.res
  try {
    const { id } = await params
    const body = await req.json()
    const current = await db.visit.findUnique({ where: { id }, include: { appointment: true } })
    if (!current) return NextResponse.json({ error: 'Визит не найден' }, { status: 404 })
    if (!canEditVisitOf(g.user, current.doctorId)) {
      return NextResponse.json({ error: 'Это приём другого врача' }, { status: 403 })
    }
    if (current.appointment.status === 'DONE') {
      return NextResponse.json({ error: 'Приём завершён — протокол изменить нельзя' }, { status: 409 })
    }
    if (body.complete && !canTransition(current.appointment.status, 'DONE')) {
      return NextResponse.json({ error: 'Завершить можно только приём пациента в клинике' }, { status: 409 })
    }

    const data: Prisma.VisitUpdateInput = {}
    if (body.complaints !== undefined) data.complaints = body.complaints === null ? null : String(body.complaints).slice(0, 4000)
    if (body.diagnosisCode !== undefined) {
      if (body.diagnosisCode === null || body.diagnosisCode === '') {
        data.diagnosisCode = null
        data.diagnosisName = null
      } else {
        const icd = await resolveIcd(body.diagnosisCode)
        if (!icd) return NextResponse.json({ error: 'Кода нет в справочнике МКБ-10 (или он неактуален/не является рубрикой)' }, { status: 400 })
        data.diagnosisCode = icd.code
        data.diagnosisName = icd.name // название — только из справочника
      }
    }
    if (body.protocolText !== undefined) data.protocolText = body.protocolText === null ? null : String(body.protocolText).slice(0, 20000)
    if (body.templateData !== undefined) data.templateData = body.templateData === null ? null : String(body.templateData)
    if (body.aiUsed !== undefined) data.aiUsed = Boolean(body.aiUsed)
    if (body.templateId) data.template = { connect: { id: String(body.templateId) } }
    if (body.serviceId !== undefined) {
      if (!body.serviceId) {
        data.service = { disconnect: true }
        data.price = 0
      } else {
        const svc = await db.serviceItem.findUnique({ where: { id: String(body.serviceId) } })
        if (!svc || !svc.active) return NextResponse.json({ error: 'Услуга не найдена в прайсе' }, { status: 400 })
        data.service = { connect: { id: svc.id } }
        data.price = svc.price // цена — из прайса, не с клиента
      }
    }
    if (body.complete && !current.serviceId && !body.serviceId) {
      return NextResponse.json({ error: 'Выберите услугу из прайса перед завершением приёма' }, { status: 400 })
    }

    const visit = await db.visit.update({ where: { id }, data })
    let stockConsumed: { totalCost: number; items: Array<{ name: string; qty: number; cost: number }>; lowStock: Array<{ name: string; qty: number; minQty: number }> } | null = null
    if (body.complete) {
      await db.appointment.update({ where: { id: visit.appointmentId }, data: { status: 'DONE' } })
      try {
        const consumption = await consumeForVisit(visit.id)
        stockConsumed = consumption
          ? { totalCost: consumption.totalCost, items: consumption.consumed, lowStock: consumption.lowStock }
          : null
      } catch (e) {
        console.error('[stock auto-consume]', e)
      }
      // ЭМД визита ставится в очередь передачи в ЕГИСЗ (в production — только при настроенном шлюзе)
      if (integrationsSimulated()) {
        try {
          await db.egiszDocument.create({ data: { visitId: visit.id, patientId: visit.patientId } }).catch(() => undefined)
          await logEvent({
            system: 'EGISZ',
            summary: `ЭМД визита ${visit.id.slice(-6).toUpperCase()} поставлен в очередь передачи в СМЭВ 3`,
            payload: { visitId: visit.id, patientId: visit.patientId },
          })
        } catch (e) {
          console.error('[egisz enqueue]', e)
        }
      }
    }
    await audit(body.complete ? 'visit.completed' : 'visit.saved', g.user.id, {
      visitId: id,
      diagnosis: visit.diagnosisCode,
      stockCost: stockConsumed?.totalCost,
    })
    const full = await db.visit.findUnique({
      where: { id },
      include: { patient: true, doctor: true, appointment: true, template: true, service: true },
    })
    return NextResponse.json({ visit: full, stockConsumed })
  } catch (e) {
    console.error('[visits PATCH]', e)
    return NextResponse.json({ error: 'Не удалось сохранить протокол' }, { status: 500 })
  }
}
