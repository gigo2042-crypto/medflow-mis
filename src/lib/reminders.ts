// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import type { Prisma } from '@prisma/client'
// Каскады напоминаний (ФТ-005, ТУ-004): за 48/24/3 часа, канал по источнику записи,
// подтверждение и отмена пациентом (кнопки в MAX или подписанная ссылка в SMS —
// входящие SMS шлюз не принимает) с авторепланированием слота.
// Доставка идёт через Центр уведомлений (ФТ-013): часы тишины, ретраи, лимиты.
// Серверный модуль — не импортировать в клиентский код!

import { db } from '@/lib/db'
import { ddmm, timeStr } from './mis-utils'
import { clinicBrand } from './clinic'
import { offerFreedSlot } from './waiting'
import { patientLink } from './patient-links'
import { enqueue, processOutbox, renderTemplate, DeliveryCounts } from './notify'

// ТУ-004: многоуровневый каскад. Правила хранятся в таблице ReminderRule
// (настраиваются в Центре уведомлений); значения ниже — только начальные.
export const DEFAULT_CASCADE: Array<{ level: number; hours: number }> = [
  { level: 1, hours: 48 },
  { level: 2, hours: 24 },
  { level: 3, hours: 3 },
]

// Канал: MAX, если пациент привязан к боту клиники (сам запустил его по ссылке-приглашению);
// иначе SMS. При отправке Центр уведомлений всё равно перепроверяет привязку и настройку MAX
// и при необходимости уходит в SMS (фолбэк).
export function channelFor(patient: { maxUserId?: string | null }): 'MAX' | 'SMS' {
  return patient.maxUserId ? 'MAX' : 'SMS'
}

export function formatStart(start: Date): string {
  return `${ddmm(start)} в ${timeStr(start)}`
}

/** Активные правила каскада; если таблица пуста — создаются правила по умолчанию. */
export async function cascadeRules(): Promise<Array<{ level: number; hours: number }>> {
  let rules = await db.reminderRule.findMany({ orderBy: { level: 'asc' } })
  if (rules.length === 0) {
    for (const r of DEFAULT_CASCADE) {
      await db.reminderRule.upsert({ where: { level: r.level }, update: {}, create: { level: r.level, hours: r.hours } })
    }
    rules = await db.reminderRule.findMany({ orderBy: { level: 'asc' } })
  }
  return rules.filter((r) => r.active).map((r) => ({ level: r.level, hours: r.hours }))
}

export function reminderText(patientName: string, doctorName: string, start: Date, replyLink?: string): string {
  const polite = patientName.split(' ')
  return `Уважаемый(ая) ${polite[polite.length - 1] || patientName}! Напоминаем о приёме: ${doctorName}, ${formatStart(start)}, ${clinicBrand()}.${replyLink ? ` Подтвердить или отменить: ${replyLink}` : ''}`
}

// Текст уровня каскада: активный шаблон из Центра уведомлений (ФТ-013),
// при его отсутствии — встроенный текст по умолчанию.
async function cascadeText(level: number, patientFirst: string, doctorName: string, start: Date, appointmentId: string): Promise<string> {
  const link = patientLink('ap', appointmentId)
  const vars: Record<string, string> = {
    'patient.firstName': patientFirst,
    'doctor.name': doctorName,
    'start.date': ddmm(start),
    'start.time': timeStr(start),
    'clinic.name': clinicBrand(),
    'reply.link': link,
  }
  const tpl = await renderTemplate(`REMINDER_L${level}`, vars)
  return tpl ?? reminderText(patientFirst, doctorName, start, link)
}

// Создать каскад напоминаний для новой записи (только будущие точки отправки)
export async function createCascade(appointmentId: string, tx: Prisma.TransactionClient | typeof db = db): Promise<number> {
  const appt = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: { patient: true, doctor: true },
  })
  if (!appt) return 0
  const startMs = appt.start.getTime()
  const now = Date.now()
  let created = 0
  for (const { level, hours } of await cascadeRules()) {
    const plannedAt = new Date(startMs - hours * 3600_000)
    if (plannedAt.getTime() <= now) continue // точка каскада уже прошла
    const text = await cascadeText(level, appt.patient.firstName, appt.doctor.name, appt.start, appt.id)
    await tx.reminder.create({
      data: {
        appointmentId,
        level,
        channel: channelFor(appt.patient),
        plannedAt,
        text,
      },
    })
    created++
  }
  return created
}

// Отменить неотправленные напоминания (приём отменён / завершён)
export async function cancelPlanned(appointmentId: string): Promise<number> {
  const res = await db.reminder.updateMany({
    where: { appointmentId, status: 'PLANNED' },
    data: { status: 'CANCELED' },
  })
  return res.count
}

// «Воркер» каскада: напоминает о наступивших точках отправки и передаёт
// сообщения в Центр уведомлений (ФТ-013) — доставку делает именно он.
export async function processDue(): Promise<{ delivery: DeliveryCounts; remindersSent: number }> {
  const due = await db.reminder.findMany({
    where: { status: 'PLANNED', plannedAt: { lte: new Date() } },
    include: { appointment: { include: { patient: true, doctor: true } } },
    take: 200,
  })
  const dueIds: string[] = []
  for (const r of due) {
    // не отправляем по отменённым/неявочным приёмам
    if (['CANCELED', 'NO_SHOW'].includes(r.appointment.status)) {
      await db.reminder.update({ where: { id: r.id }, data: { status: 'CANCELED' } })
      continue
    }
    dueIds.push(r.id)
    // постановка в центр уведомлений, если сообщения ещё нет (идемпотентно)
    const existing = await db.notification.findUnique({ where: { relatedReminderId: r.id } })
    if (!existing) {
      const p = r.appointment.patient
      // уникальный индекс Notification.relatedReminderId: параллельный воркер получит P2002 — дубля не будет
      await enqueue({
        kind: 'REMINDER',
        channel: r.channel,
        phone: p.phone,
        text: r.text ?? reminderText(p.firstName, r.appointment.doctor.name, r.appointment.start, patientLink('ap', r.appointmentId)),
        patientId: p.id,
        patientName: `${p.lastName} ${p.firstName}`,
        relatedAppointmentId: r.appointmentId,
        relatedReminderId: r.id,
      }).catch((e) => {
        if (!(e && typeof e === 'object' && 'code' in e && e.code === 'P2002')) throw e
      })
    }
  }
  // доставка центром: часы тишины / лимиты / ретраи + синхронизация статусов
  const delivery = await processOutbox()
  const remindersSent = dueIds.length
    ? await db.reminder.count({ where: { id: { in: dueIds }, status: 'SENT' } })
    : 0
  return { delivery, remindersSent }
}

// Ответ пациента по приёму (ФТ-005, ТУ-004): кнопка в MAX, страница по подписанной ссылке
// или отметка регистратора. Повторный ответ ничего не меняет (идемпотентно).
export async function respondAppointment(
  appointmentId: string,
  response: 'CONFIRMED' | 'DECLINED'
): Promise<{ appointmentId: string; offeredTo: string | null; canceledReminders: number; changed: boolean; status: string }> {
  const appt = await db.appointment.findUnique({ where: { id: appointmentId } })
  if (!appt) throw new Error('Запись не найдена')
  const now = new Date()
  if (!['BOOKED', 'CONFIRMED'].includes(appt.status) || appt.start.getTime() <= now.getTime()) {
    return { appointmentId, offeredTo: null, canceledReminders: 0, changed: false, status: appt.status }
  }
  // ответ фиксируется на последнем отправленном напоминании (для статистики каскада)
  const lastSent = await db.reminder.findFirst({ where: { appointmentId, status: 'SENT' }, orderBy: { sentAt: 'desc' } })
  if (lastSent && !lastSent.response) {
    await db.reminder.update({ where: { id: lastSent.id }, data: { response, respondedAt: now } })
  }
  if (response === 'CONFIRMED') {
    if (appt.status === 'CONFIRMED') return { appointmentId, offeredTo: null, canceledReminders: 0, changed: false, status: 'CONFIRMED' }
    await db.appointment.updateMany({ where: { id: appointmentId, status: 'BOOKED' }, data: { status: 'CONFIRMED' } })
    return { appointmentId, offeredTo: null, canceledReminders: 0, changed: true, status: 'CONFIRMED' }
  }
  // DECLINED: отмена приёма + авторепланирование — слот предлагается листу ожидания (ТУ-004)
  const upd = await db.appointment.updateMany({ where: { id: appointmentId, status: { in: ['BOOKED', 'CONFIRMED'] } }, data: { status: 'CANCELED' } })
  if (upd.count === 0) return { appointmentId, offeredTo: null, canceledReminders: 0, changed: false, status: 'CANCELED' }
  const canceled = await cancelPlanned(appointmentId)
  const offer = await offerFreedSlot(appt.doctorId, appt.start)
  return { appointmentId, offeredTo: offer?.patientName ?? null, canceledReminders: canceled, changed: true, status: 'CANCELED' }
}

// Ответ пациента из напоминания: «1 — подтверждаю, 2 — отменяю» (ФТ-005, ТУ-004)
export async function respondReminder(
  reminderId: string,
  response: 'CONFIRMED' | 'DECLINED'
): Promise<{
  appointmentId: string
  offeredTo: string | null
  canceledReminders: number
}> {
  const r = await db.reminder.findUnique({ where: { id: reminderId }, include: { appointment: { include: { patient: true } } } })
  if (!r) throw new Error('Напоминание не найдено')
  if (r.status !== 'SENT') throw new Error('Ответ фиксируется только по отправленным напоминаниям')
  const now = new Date()
  await db.reminder.update({
    where: { id: reminderId },
    data: { response, respondedAt: now },
  })

  if (response === 'CONFIRMED') {
    await db.appointment.update({ where: { id: r.appointmentId }, data: { status: 'CONFIRMED' } })
    return { appointmentId: r.appointmentId, offeredTo: null, canceledReminders: 0 }
  }

  // DECLINED: отмена приёма + авторепланирование — слот предлагается листу ожидания (ТУ-004);
  // приглашение уходит пациенту из очереди через Центр уведомлений (ФТ-013)
  const canceled = await cancelPlanned(r.appointmentId)
  await db.appointment.update({ where: { id: r.appointmentId }, data: { status: 'CANCELED' } })
  const appt = r.appointment
  let offeredTo: string | null = null
  if (appt.start.getTime() > now.getTime()) {
    const offer = await offerFreedSlot(appt.doctorId, appt.start)
    offeredTo = offer?.patientName ?? null
  }
  return { appointmentId: r.appointmentId, offeredTo, canceledReminders: canceled }
}
