// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { scoreNoShow } from '@/lib/no-show'
import { cancelPlanned } from '@/lib/reminders'
import { enqueue, processOutbox, renderTemplate } from '@/lib/notify'
import { matchesEntry, offerFreedSlot } from '@/lib/waiting'
import { clinicDayStart, ddmm, pad2, timeStr } from '@/lib/mis-utils'
import { TodayRiskDTO, TodayRisksDTO } from '@/lib/types'
import { doctorFilterId } from '@/lib/pd-access'
import { clinicBrand } from '@/lib/clinic'
import { patientLink } from '@/lib/patient-links'

export const dynamic = 'force-dynamic'

// Панель «риски на сегодня» (ТУ-004, v2): предиктивный скор по каждому
// приближающемуся приёму, факторы модели и сценарии обработки; для высоких
// рисков заранее видна готовая замена из листа ожидания.
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'schedule.read')
  if (!g.ok) return g.res
  try {
    const now = new Date()
    const dayStart = clinicDayStart(0)
    const dayEnd = clinicDayStart(1)

    const todayAppts = await db.appointment.findMany({
      where: {
        start: { gte: dayStart, lt: dayEnd },
        status: { in: ['BOOKED', 'CONFIRMED', 'ARRIVED'] },
        ...(doctorFilterId(g.user) ? { doctorId: doctorFilterId(g.user)! } : {}),
      },
      include: { patient: true, doctor: true },
      orderBy: { start: 'asc' },
      take: 120,
    })

    // История пациентов: неявки, прошлые приёмы, визиты (лояльность)
    const patientIds = [...new Set(todayAppts.map((a) => a.patientId))]
    const histAppts = await db.appointment.findMany({
      where: { patientId: { in: patientIds }, start: { lt: dayStart } },
      select: { patientId: true, status: true },
    })
    const pastNoShows = new Map<string, number>()
    const pastAppointments = new Map<string, number>()
    for (const h of histAppts) {
      pastAppointments.set(h.patientId, (pastAppointments.get(h.patientId) || 0) + 1)
      if (h.status === 'NO_SHOW') pastNoShows.set(h.patientId, (pastNoShows.get(h.patientId) || 0) + 1)
    }
    const visits = await db.visit.findMany({ where: { patientId: { in: patientIds } }, select: { patientId: true } })
    const visitsCount = new Map<string, number>()
    for (const v of visits) visitsCount.set(v.patientId, (visitsCount.get(v.patientId) || 0) + 1)

    // Канал и результат подтверждения: ответы на напоминания (ТУ-004)
    const apptIds = todayAppts.map((a) => a.id)
    const reminders = apptIds.length
      ? await db.reminder.findMany({ where: { appointmentId: { in: apptIds } }, select: { appointmentId: true, status: true, response: true } })
      : []
    const remByAppt = new Map<string, { sent: number; confirmed: number; declined: number }>()
    for (const r of reminders) {
      const agg = remByAppt.get(r.appointmentId) || { sent: 0, confirmed: 0, declined: 0 }
      if (r.status === 'SENT') agg.sent++
      if (r.response === 'CONFIRMED') agg.confirmed++
      if (r.response === 'DECLINED') agg.declined++
      remByAppt.set(r.appointmentId, agg)
    }

    // Предиктивная подготовка замены: активные заявки листа ожидания (ТУ-004)
    const activeEntries = await db.waitingListEntry.findMany({
      where: { status: 'ACTIVE' },
      include: { patient: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    })

    const items: TodayRiskDTO[] = todayAppts.map((a) => {
      const rem = remByAppt.get(a.id) || { sent: 0, confirmed: 0, declined: 0 }
      const s = scoreNoShow({
        start: a.start,
        now,
        source: a.source,
        appointmentStatus: a.status,
        specialty: a.doctor.specialty,
        pastNoShows: pastNoShows.get(a.patientId) || 0,
        pastAppointments: pastAppointments.get(a.patientId) || 0,
        visitsCount: visitsCount.get(a.patientId) || 0,
        reminderSent: rem.sent,
        reminderConfirmed: rem.confirmed,
        reminderDeclined: rem.declined,
      })
      const candidates = activeEntries.filter((e) => matchesEntry(e, a.doctorId, a.start, a.doctor.specialty))
      return {
        appointmentId: a.id,
        patientId: a.patientId,
        patientName: `${a.patient.lastName} ${a.patient.firstName}`,
        patientPhone: a.patient.phone,
        doctorName: a.doctor.name,
        doctorSpecialty: a.doctor.specialty,
        start: a.start.toISOString(),
        status: a.status,
        source: a.source,
        score: s.score,
        scoreLabel: s.label,
        scoreClass: s.riskClass,
        factors: s.factors.map((f) => ({ label: f.label, impact: f.impact })),
        scenarioAction: s.scenario.action,
        scenarioHint: s.scenario.hint,
        waitlistCandidates: candidates.length,
        waitlistFirst: candidates[0] ? `${candidates[0].patient.lastName} ${candidates[0].patient.firstName}` : null,
      }
    })

    const dto: TodayRisksDTO = {
      items: items.sort((x, y) => y.score - x.score).slice(0, 12),
      totals: {
        high: items.filter((i) => i.score >= 50).length,
        medium: items.filter((i) => i.score >= 30 && i.score < 50).length,
        low: items.filter((i) => i.score < 30).length,
        checked: items.length,
      },
    }
    return NextResponse.json(dto)
  } catch (e) {
    console.error('[no-show-risks GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить риски' }, { status: 500 })
  }
}

// Сценарии обработки высокого риска (ТУ-004): фиксация звонка, срочное
// SMS-касание через Центр уведомлений (ФТ-013), перевод в неявку с
// автоматическим приглашением из листа ожидания.
export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'appointments.update')
  if (!g.ok) return g.res
  try {
    const body = await req.json()
    const action = body.action
    if (!body.id) return NextResponse.json({ error: 'Укажите id приёма' }, { status: 400 })

    const appt = await db.appointment.findUnique({
      where: { id: body.id },
      include: { patient: true, doctor: true },
    })
    if (!appt) return NextResponse.json({ error: 'Приём не найден' }, { status: 404 })

    // Сценарий «позвонить сейчас»: фиксация попытки в аудите
    if (action === 'CALL') {
      if (!['BOOKED', 'CONFIRMED', 'ARRIVED'].includes(appt.status)) {
        return NextResponse.json({ error: 'Приём уже закрыт' }, { status: 400 })
      }
      await audit('risk.call_logged', g.user.id, {
        appointmentId: appt.id,
        patient: `${appt.patient.lastName} ${appt.patient.firstName}`,
      })
      return NextResponse.json({ ok: true })
    }

    // Сценарий «доп. касание»: срочное сообщение через Центр уведомлений (ФТ-013)
    if (action === 'TOUCH') {
      if (!['BOOKED', 'CONFIRMED', 'ARRIVED'].includes(appt.status)) {
        return NextResponse.json({ error: 'Приём уже закрыт' }, { status: 400 })
      }
      const vars: Record<string, string> = {
        'patient.firstName': appt.patient.firstName,
        'doctor.name': appt.doctor.name,
        'start.date': `${ddmm(appt.start)}`,
        'start.time': `${timeStr(appt.start)}`,
        'clinic.name': clinicBrand(),
        'reply.link': patientLink('ap', appt.id),
      }
      const text =
        (await renderTemplate('RISK_TOUCH', vars)) ??
        `${appt.patient.firstName}, подтвердите, пожалуйста, приём у ${appt.doctor.name} — ${ddmm(appt.start)} в ${timeStr(appt.start)}. Подтвердить или отменить: ${patientLink('ap', appt.id)}`
      const channel = appt.patient.maxUserId ? 'MAX' : 'SMS'
      const queued = await enqueue({
        kind: 'RISK_TOUCH',
        channel,
        phone: appt.patient.phone,
        text,
        patientId: appt.patientId,
        patientName: `${appt.patient.lastName} ${appt.patient.firstName}`,
        priority: 1,
        relatedAppointmentId: appt.id,
      })
      if (queued.status === 'BLOCKED_BLACKLIST') {
        return NextResponse.json({ error: 'Телефон пациента в чёрном списке Центра уведомлений (ФТ-013)' }, { status: 400 })
      }
      await processOutbox(20)
      const fresh = await db.notification.findUnique({ where: { id: queued.id } })
      await audit('risk.touch_sent', g.user.id, { appointmentId: appt.id, notificationStatus: fresh?.status })
      return NextResponse.json({ ok: true, notificationStatus: fresh?.status ?? 'QUEUED' })
    }

    // Сценарий «не пришёл»: фиксация неявки + автоприглашение из листа ожидания
    if (action === 'MARK_NO_SHOW') {
      if (!['BOOKED', 'CONFIRMED', 'ARRIVED'].includes(appt.status)) {
        return NextResponse.json({ error: 'Приём уже закрыт' }, { status: 400 })
      }
      await cancelPlanned(appt.id)
      await db.appointment.update({ where: { id: appt.id }, data: { status: 'NO_SHOW' } })
      let offeredTo: string | null = null
      let notificationStatus: string | null = null
      if (appt.start.getTime() > Date.now()) {
        const offer = await offerFreedSlot(appt.doctorId, appt.start)
        offeredTo = offer?.patientName ?? null
        notificationStatus = offer?.notificationStatus ?? null
      }
      await audit('risk.marked_no_show', g.user.id, {
        appointmentId: appt.id,
        offeredTo,
        notificationStatus,
      })
      return NextResponse.json({ ok: true, offeredTo, notificationStatus })
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 })
  } catch (e) {
    console.error('[no-show-risks POST]', e)
    return NextResponse.json({ error: 'Не удалось выполнить действие' }, { status: 500 })
  }
}
