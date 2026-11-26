// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { doctorFilterId } from '@/lib/pd-access'
import { db } from '@/lib/db'
import { actorId, actorMeta, audit, isService, requirePerm, requireServiceOrPerm } from '@/lib/auth-server'
import { hadWork } from '@/lib/audit-utils'
import { processExpiredOffers } from '@/lib/waiting'
import { processDue, respondReminder } from '@/lib/reminders'
import { enqueue, processOutbox } from '@/lib/notify'
import { ReminderDTO, ReminderStats } from '@/lib/types'
import { clinicDayStart } from '@/lib/mis-utils'

export const dynamic = 'force-dynamic'

type Row = {
  id: string
  appointmentId: string
  level: number
  channel: string
  plannedAt: Date
  status: string
  sentAt: Date | null
  text: string | null
  response: string | null
  respondedAt: Date | null
  appointment: {
    id: string
    status: string
    start: Date
    patient: { lastName: string; firstName: string; middleName: string | null; phone: string; id: string }
    doctor: { name: string }
  }
}

function toDTO(r: Row): ReminderDTO {
  return {
    id: r.id,
    appointmentId: r.appointmentId,
    appointmentStatus: r.appointment.status,
    patientId: r.appointment.patient.id,
    patientName: `${r.appointment.patient.lastName} ${r.appointment.patient.firstName}${r.appointment.patient.middleName ? ' ' + r.appointment.patient.middleName : ''}`,
    patientPhone: r.appointment.patient.phone,
    doctorName: r.appointment.doctor.name,
    start: r.appointment.start.toISOString(),
    level: r.level,
    channel: r.channel,
    plannedAt: r.plannedAt.toISOString(),
    sentAt: r.sentAt?.toISOString() ?? null,
    status: r.status,
    text: r.text,
    response: r.response,
    respondedAt: r.respondedAt?.toISOString() ?? null,
  }
}

// Каскады напоминаний (ФТ-005): журнал + статистика доставки и ответов
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'reminders.read')
  if (!g.ok) return g.res
  try {
    const take = Math.min(Number(req.nextUrl.searchParams.get('take')) || 120, 300)
    const since = clinicDayStart(-1)
    const rows = await db.reminder.findMany({
      where: { appointment: { start: { gte: since }, ...(doctorFilterId(g.user) ? { doctorId: doctorFilterId(g.user)! } : {}) } },
      include: { appointment: { include: { patient: true, doctor: true } } },
      orderBy: [{ appointment: { start: 'asc' } }, { level: 'asc' }],
      take,
    })
    const stats: ReminderStats = {
      planned: rows.filter((r) => r.status === 'PLANNED').length,
      sent: rows.filter((r) => r.status === 'SENT').length,
      confirmed: rows.filter((r) => r.response === 'CONFIRMED').length,
      declined: rows.filter((r) => r.response === 'DECLINED').length,
      canceled: rows.filter((r) => r.status === 'CANCELED').length,
      failed: rows.filter((r) => r.status === 'FAILED').length,
      dueNow: rows.filter((r) => r.status === 'PLANNED' && r.plannedAt.getTime() <= Date.now()).length,
    }
    return NextResponse.json({ reminders: rows.map((r) => toDTO(r as Row)), stats })
  } catch (e) {
    console.error('[reminders GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить напоминания' }, { status: 500 })
  }
}

// Действия по напоминаниям (ФТ-005, ТУ-004):
// PROCESS — воркер каскада: ставит наступившие напоминания в Центр уведомлений (ФТ-013)
// и запускает доставку (часы тишины, ретраи, лимиты);
// SEND_NOW — немедленная отправка одного напоминания через Центр уведомлений;
// RESPOND — зафиксировать ответ пациента «1 — подтверждаю / 2 — отменяю» с авторепланированием
export async function POST(req: NextRequest) {
  let body: Record<string, any>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 })
  }
  const action = body.action
  // PROCESS вызывает планировщик (X-Service-Key) или сотрудник с правом reminders.manage
  const g = action === 'PROCESS' ? await requireServiceOrPerm(req, 'reminders.manage') : await requirePerm(req, 'reminders.manage')
  if (!g.ok) return g.res
  try {
    if (action === 'PROCESS') {
      const expiredOffers = await processExpiredOffers()
      const res = await processDue()
      if (!isService(req) || hadWork(res.delivery, res.remindersSent, expiredOffers)) {
        await audit('reminder.batch_sent', actorId(g), { ...res, expiredOffers, ...actorMeta(g) })
      }
      return NextResponse.json({ ...res, expiredOffers })
    }

    // Служебному вызову (x-service-key) доступен только запуск воркера
    if (!g.user) return NextResponse.json({ error: 'Служебный вызов: только PROCESS' }, { status: 403 })

    if (action === 'SEND_NOW') {
      if (!body.id) return NextResponse.json({ error: 'Укажите id напоминания' }, { status: 400 })
      const r = await db.reminder.findUnique({
        where: { id: body.id },
        include: { appointment: { include: { patient: true } } },
      })
      if (!r) return NextResponse.json({ error: 'Напоминание не найдено' }, { status: 404 })
      if (r.status !== 'PLANNED') {
        return NextResponse.json({ error: 'Отправить можно только запланированное' }, { status: 400 })
      }
      if (['CANCELED', 'NO_SHOW'].includes(r.appointment.status)) {
        await db.reminder.update({ where: { id: r.id }, data: { status: 'CANCELED' } })
        return NextResponse.json({ error: 'Приём отменён — напоминание снято' }, { status: 400 })
      }
      const p = r.appointment.patient
      // Сообщение по напоминанию уже в очереди (например, ждёт конца часов тишины) —
      // поднимаем его приоритет вместо создания дубля (одно сообщение на напоминание)
      const existing = await db.notification.findUnique({ where: { relatedReminderId: r.id } })
      if (existing?.status === 'BLOCKED_BLACKLIST') {
        return NextResponse.json({ error: 'Телефон пациента в чёрном списке Центра уведомлений (ФТ-013)' }, { status: 400 })
      }
      if (existing && !['QUEUED', 'DEFERRED_QUIET', 'BLOCKED_LIMIT', 'FAILED'].includes(existing.status)) {
        return NextResponse.json({ error: 'Сообщение по напоминанию уже отправляется или отправлено' }, { status: 409 })
      }
      const queued = existing
        ? await db.notification
            .update({ where: { id: existing.id }, data: { status: 'QUEUED', priority: 1, nextAttemptAt: new Date(), attempts: 0, error: null } })
            .then((n) => ({ id: n.id, status: n.status }))
        : await enqueue({
        kind: 'REMINDER',
        channel: r.channel,
        phone: p.phone,
        text: r.text ?? '',
        patientId: p.id,
        patientName: `${p.lastName} ${p.firstName}`,
        relatedAppointmentId: r.appointmentId,
        relatedReminderId: r.id,
        priority: 1, // ручная отправка — срочная, в обход часам тишины
      })
      if (queued.status === 'BLOCKED_BLACKLIST') {
        return NextResponse.json({ error: 'Телефон пациента в чёрном списке Центра уведомлений (ФТ-013)' }, { status: 400 })
      }
      await processOutbox(20)
      const fresh = await db.notification.findUnique({ where: { id: queued.id } })
      await audit('reminder.sent_now', g.user.id, { reminderId: r.id, notificationStatus: fresh?.status })
      return NextResponse.json({ ok: true, notificationStatus: fresh?.status ?? 'QUEUED' })
    }

    if (action === 'RESPOND') {
      if (!body.id || !['CONFIRMED', 'DECLINED'].includes(body.response)) {
        return NextResponse.json({ error: 'Укажите id и response: CONFIRMED | DECLINED' }, { status: 400 })
      }
      const result = await respondReminder(body.id, body.response)
      await audit('reminder.responded', g.user.id, {
        reminderId: body.id,
        response: body.response,
        offeredTo: result.offeredTo,
      })
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 })
  } catch (e) {
    if (e instanceof Error) {
      return NextResponse.json({ error: e.message }, { status: 400 })
    }
    console.error('[reminders POST]', e)
    return NextResponse.json({ error: 'Не удалось выполнить действие' }, { status: 500 })
  }
}
