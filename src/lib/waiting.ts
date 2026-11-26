// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Лист ожидания (ФТ-004): подбор по соответствию «врач / направление, окно времени, дни»
// и автопредложение освободившегося слота с ограничением времени ответа (ТУ-004).
// Приглашение пациенту отправляет Центр уведомлений (ФТ-013) — предиктивные
// автоприглашения из очереди (v2-часть ТУ-004).
// Серверный модуль — не импортировать в клиентский код!

import { db } from '@/lib/db'
import { checkSlot } from './schedule-days'
import { clinicBrand } from '@/lib/clinic'
import { clinicMinutes, ddmm, minutesOf, timeStr, zonedParts } from './mis-utils'
import { enqueue, processOutbox, renderTemplate } from './notify'
import { patientLink } from './patient-links'

// ТУ-004: ограничение времени ответа на предложенный слот
export const OFFER_TTL_MINUTES = 15

type EntryLike = {
  doctorId: string | null
  specialty: string | null
  daysMask: string
  fromTime: string
  toTime: string
}

export function matchesEntry(
  e: EntryLike,
  doctorId: string,
  start: Date,
  doctorSpecialty: string
): boolean {
  // Врач или направление
  if (e.doctorId) {
    if (e.doctorId !== doctorId) return false
  } else if (e.specialty && e.specialty !== doctorSpecialty) {
    return false
  }
  // Окно времени
  const m = clinicMinutes(start)
  if (m < minutesOf(e.fromTime) || m >= minutesOf(e.toTime)) return false
  // Дни недели (daysMask: индекс 0 = Пн)
  const idx = zonedParts(start).weekday
  if (e.daysMask[idx] !== '1') return false
  return true
}

// Приглашение на освободившийся слот: активный шаблон WAITLIST_OFFER (ФТ-013)
// либо текст по умолчанию.
async function invitationText(
  patientFirst: string,
  doctorName: string,
  start: Date,
  entryId: string
): Promise<string> {
  const link = patientLink('wl', entryId)
  const vars: Record<string, string> = {
    'reply.link': link,
    'patient.firstName': patientFirst,
    'doctor.name': doctorName,
    'start.date': ddmm(start),
    'start.time': timeStr(start),
    'offer.ttl': String(OFFER_TTL_MINUTES),
    'clinic.name': clinicBrand(),
  }
  const tpl = await renderTemplate('WAITLIST_OFFER', vars)
  return (
    tpl ??
    `${patientFirst}, освободилось время у врача ${doctorName}: ${ddmm(start)} в ${timeStr(start)}. Записаться или отказаться: ${link} Предложение действует ${OFFER_TTL_MINUTES} минут.`
  )
}

// Автоприглашение из листа ожидания на освободившийся слот (ТУ-004, v2):
// первый подходящий по приоритету и FIFO; слот «удерживается» за пациентом
// OFFER_TTL_MINUTES, приглашение уходит по SMS через Центр уведомлений.
export async function offerFreedSlot(
  doctorId: string,
  start: Date
): Promise<{ entryId: string; patientName: string; notificationStatus: string } | null> {
  const doctor = await db.doctor.findUnique({ where: { id: doctorId } })
  if (!doctor) return null
  const entries = await db.waitingListEntry.findMany({
    where: { status: 'ACTIVE' },
    include: { patient: true },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  })
  const match = entries.find((e) => matchesEntry(e, doctorId, start, doctor.specialty))
  if (!match) return null
  await db.waitingListEntry.update({
    where: { id: match.id },
    data: {
      status: 'OFFERED',
      offeredDoctorId: doctorId,
      offeredSlot: start,
      offeredAt: new Date(),
      offerExpiresAt: new Date(Date.now() + OFFER_TTL_MINUTES * 60_000),
    },
  })
  const patientName = `${match.patient.lastName} ${match.patient.firstName}`
  // Приглашение — срочное (priority 1): TTL слота 15 минут, обходит часы тишины
  const text = await invitationText(match.patient.firstName, doctor.name, start, match.id)
  const queued = await enqueue({
    kind: 'WAITLIST_OFFER',
    channel: match.patient.maxUserId ? 'MAX' : 'SMS',
    phone: match.patient.phone,
    text,
    patientId: match.patientId,
    patientName,
    priority: 1,
    relatedWaitingId: match.id,
  })
  let notificationStatus = queued.status
  if (queued.status === 'QUEUED') {
    await processOutbox(20)
    const fresh = await db.notification.findUnique({ where: { id: queued.id } })
    notificationStatus = fresh?.status ?? 'QUEUED'
  }
  return { entryId: match.id, patientName, notificationStatus }
}

// Истёкшие предложения → EXPIRED, слот каскадно уходит следующему в очереди
export async function processExpiredOffers(): Promise<number> {
  const expired = await db.waitingListEntry.findMany({
    where: { status: 'OFFERED', offerExpiresAt: { lt: new Date() } },
  })
  for (const e of expired) {
    await db.waitingListEntry.update({ where: { id: e.id }, data: { status: 'EXPIRED' } })
    if (e.offeredDoctorId && e.offeredSlot && e.offeredSlot.getTime() > Date.now()) {
      // слот ещё актуален — предложим следующему в очереди
      await offerFreedSlot(e.offeredDoctorId, e.offeredSlot)
    }
  }
  return expired.length
}

// Черновики виджета (ФТ-012): ФИО, телефон, код и IP нужны только на время удержания слота.
// После подтверждения или истечения — стираются сразу; сами строки удаляются через сутки (152-ФЗ, минимизация).
export const WIDGET_DRAFT_SCRUB = { name: '', phone: '', code: '', consentIp: null } as const
export const WIDGET_DRAFT_RETENTION_MS = 24 * 3600_000

export async function expireWidgetDrafts(now = new Date()): Promise<number> {
  const res = await db.widgetDraft.updateMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    data: { status: 'EXPIRED', ...WIDGET_DRAFT_SCRUB },
  })
  // доочистка завершённых черновиков, если где-то статус сменили без очистки (сбой, старые данные)
  await db.widgetDraft.updateMany({
    where: { status: { in: ['CONFIRMED', 'EXPIRED'] }, OR: [{ phone: { not: '' } }, { name: { not: '' } }, { code: { not: '' } }, { consentIp: { not: null } }] },
    data: WIDGET_DRAFT_SCRUB,
  })
  await db.widgetDraft.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - WIDGET_DRAFT_RETENTION_MS) }, status: { not: 'PENDING' } } })
  // зависший PENDING старше суток (часы, сбой) — тоже удаляем
  await db.widgetDraft.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - WIDGET_DRAFT_RETENTION_MS) }, expiresAt: { lt: now } } })
  return res.count
}

export class WaitingError extends Error {
  constructor(message: string, public status: number) {
    super(message)
  }
}

// Запись из листа ожидания: принять автопредложение (OFFERED) или ручная рассадка (ACTIVE).
// Используется регистратурой, страницей ответа пациента и кнопкой в MAX.
export async function bookFromWaiting(
  entryId: string,
  opts: { doctorId?: string | null; start?: string | null; source?: string } = {}
): Promise<{ appointmentId: string; start: Date; doctorId: string; remindersCreated: number; fromOffer: boolean }> {
  const entry = await db.waitingListEntry.findUnique({ where: { id: entryId } })
  if (!entry) throw new WaitingError('Заявка не найдена', 404)
  if (!['ACTIVE', 'OFFERED'].includes(entry.status)) throw new WaitingError('Заявка уже закрыта', 400)
  let doctorId: string
  let startDt: Date
  if (entry.status === 'OFFERED') {
    if (!entry.offeredDoctorId || !entry.offeredSlot) throw new WaitingError('У заявки нет предложенного слота', 400)
    if (entry.offerExpiresAt && entry.offerExpiresAt.getTime() < Date.now()) throw new WaitingError('Время на ответ истекло — слот предложен следующему', 410)
    doctorId = entry.offeredDoctorId
    startDt = entry.offeredSlot
  } else {
    const d = opts.doctorId || entry.doctorId
    if (!d) throw new WaitingError('Для заявки «любой врач» укажите doctorId', 400)
    if (!opts.start) throw new WaitingError('Укажите слот (start)', 400)
    doctorId = d
    startDt = new Date(opts.start)
  }
  const doctor = await db.doctor.findUnique({ where: { id: doctorId } })
  if (!doctor) throw new WaitingError('Врач не найден', 404)
  const err = await checkSlot(doctor, startDt)
  if (err) throw new WaitingError(err, 400)
  try {
    const appointment = await db.appointment.create({
      data: { patientId: entry.patientId, doctorId, start: startDt, duration: doctor.slotMinutes, source: opts.source ?? 'REGISTRAR' },
    })
    // защита от гонки: заявку закрывает только тот, кто перевёл её из ACTIVE/OFFERED
    const closed = await db.waitingListEntry.updateMany({
      where: { id: entryId, status: { in: ['ACTIVE', 'OFFERED'] } },
      data: { status: 'BOOKED', bookedAppointmentId: appointment.id },
    })
    if (closed.count === 0) {
      await db.appointment.update({ where: { id: appointment.id }, data: { status: 'CANCELED' } })
      throw new WaitingError('Заявка уже закрыта', 409)
    }
    const { createCascade } = await import('./reminders')
    const remindersCreated = await createCascade(appointment.id)
    return { appointmentId: appointment.id, start: startDt, doctorId, remindersCreated, fromOffer: entry.status === 'OFFERED' }
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'P2002') {
      throw new WaitingError('Слот уже занят — двойная бронь заблокирована. Предложите пациенту другой слот', 409)
    }
    throw e
  }
}

// Пациент отказался от предложенного слота — слот каскадно уходит следующему в очереди
export async function declineOffer(entryId: string): Promise<{ offeredTo: string | null }> {
  const entry = await db.waitingListEntry.findUnique({ where: { id: entryId } })
  if (!entry || entry.status !== 'OFFERED') throw new WaitingError('Предложение уже неактуально', 400)
  const upd = await db.waitingListEntry.updateMany({ where: { id: entryId, status: 'OFFERED' }, data: { status: 'DECLINED' } })
  if (upd.count === 0) throw new WaitingError('Предложение уже неактуально', 400)
  let offeredTo: string | null = null
  if (entry.offeredDoctorId && entry.offeredSlot && entry.offeredSlot.getTime() > Date.now()) {
    const offer = await offerFreedSlot(entry.offeredDoctorId, entry.offeredSlot)
    offeredTo = offer?.patientName ?? null
  }
  return { offeredTo }
}
