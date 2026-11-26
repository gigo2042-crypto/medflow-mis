// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Действия пациента без входа в систему: по подписанной ссылке (SMS) или кнопкой/командой в MAX.
// Серверный модуль — не импортировать в клиентский код!
import { db } from '@/lib/db'
import { recordConsent, type ConsentSource } from '@/lib/consent'
import { respondAppointment } from '@/lib/reminders'
import { bookFromWaiting, declineOffer, WaitingError } from '@/lib/waiting'
import { ddmm, timeStr } from '@/lib/mis-utils'
import type { LinkKind } from '@/lib/patient-links'

export type PatientAction = 'confirm' | 'cancel' | 'book' | 'decline' | 'unsubscribe'

export interface LinkInfo {
  kind: LinkKind
  title: string
  details: string | null
  actions: PatientAction[]
  state: string
}

// Минимум сведений на публичной странице: без ФИО, телефона и диагноза —
// только врач (специальность) и время.
export async function linkInfo(kind: LinkKind, id: string): Promise<LinkInfo | null> {
  if (kind === 'ap') {
    const a = await db.appointment.findUnique({ where: { id }, include: { doctor: { select: { specialty: true } } } })
    if (!a) return null
    const active = ['BOOKED', 'CONFIRMED'].includes(a.status) && a.start.getTime() > Date.now()
    return {
      kind, title: 'Ваша запись', details: `${a.doctor.specialty}, ${ddmm(a.start)} в ${timeStr(a.start)}`,
      actions: active ? (a.status === 'CONFIRMED' ? ['cancel'] : ['confirm', 'cancel']) : [],
      state: a.status === 'CONFIRMED' ? 'Запись подтверждена' : a.status === 'CANCELED' ? 'Запись отменена' : active ? 'Ждём вашего ответа' : 'Запись уже неактуальна',
    }
  }
  if (kind === 'wl') {
    const e = await db.waitingListEntry.findUnique({ where: { id }, include: { offeredDoctor: { select: { specialty: true } } } })
    if (!e) return null
    const live = e.status === 'OFFERED' && (!e.offerExpiresAt || e.offerExpiresAt.getTime() > Date.now())
    return {
      kind, title: 'Освободилось время',
      details: e.offeredSlot && e.offeredDoctor ? `${e.offeredDoctor.specialty}, ${ddmm(e.offeredSlot)} в ${timeStr(e.offeredSlot)}` : null,
      actions: live ? ['book', 'decline'] : [],
      state: e.status === 'BOOKED' ? 'Вы записаны' : live ? 'Предложение действует ограниченное время' : 'Предложение уже неактуально',
    }
  }
  if (kind === 'u') {
    const p = await db.patient.findUnique({ where: { id }, select: { marketingConsent: true, anonymizedAt: true } })
    if (!p || p.anonymizedAt) return null
    return {
      kind, title: 'Рекламные рассылки', details: null,
      actions: p.marketingConsent ? ['unsubscribe'] : [],
      state: p.marketingConsent ? 'Вы подписаны на рекламные сообщения клиники' : 'Вы отписаны от рекламных сообщений',
    }
  }
  return null
}

export async function unsubscribeMarketing(patientId: string, source: ConsentSource, ip?: string | null): Promise<boolean> {
  const p = await db.patient.findUnique({ where: { id: patientId }, select: { marketingConsent: true } })
  if (!p || !p.marketingConsent) return false
  await recordConsent({ patientId, kind: 'MARKETING', action: 'REVOKED', source, ip: ip ?? null })
  return true
}

/** Выполнить действие пациента. Возвращает текст результата для страницы/MAX. */
export async function performPatientAction(kind: LinkKind, id: string, action: PatientAction, source: ConsentSource, ip?: string | null): Promise<{ ok: boolean; message: string; auditAction: string | null }> {
  if (kind === 'ap' && (action === 'confirm' || action === 'cancel')) {
    const r = await respondAppointment(id, action === 'confirm' ? 'CONFIRMED' : 'DECLINED')
    if (!r.changed) return { ok: r.status === (action === 'confirm' ? 'CONFIRMED' : 'CANCELED'), message: r.status === 'CONFIRMED' ? 'Запись уже подтверждена' : r.status === 'CANCELED' ? 'Запись уже отменена' : 'Запись уже неактуальна', auditAction: null }
    return { ok: true, message: action === 'confirm' ? 'Спасибо! Запись подтверждена.' : 'Запись отменена. Спасибо, что предупредили.', auditAction: action === 'confirm' ? 'patient.appointment_confirmed' : 'patient.appointment_canceled' }
  }
  if (kind === 'wl' && (action === 'book' || action === 'decline')) {
    try {
      if (action === 'book') {
        const r = await bookFromWaiting(id, { source: 'WAITLIST' })
        return { ok: true, message: `Вы записаны: ${ddmm(r.start)} в ${timeStr(r.start)}.`, auditAction: 'patient.waitlist_booked' }
      }
      await declineOffer(id)
      return { ok: true, message: 'Хорошо, предложим время в другой раз.', auditAction: 'patient.waitlist_declined' }
    } catch (e) {
      if (e instanceof WaitingError) return { ok: false, message: e.message, auditAction: null }
      throw e
    }
  }
  if (kind === 'u' && action === 'unsubscribe') {
    const changed = await unsubscribeMarketing(id, source, ip)
    return { ok: true, message: 'Вы отписаны от рекламных сообщений. Напоминания о записях продолжат приходить.', auditAction: changed ? 'patient.marketing_unsubscribed' : null }
  }
  return { ok: false, message: 'Действие недоступно', auditAction: null }
}

// ---------- Привязка MAX ----------

export async function linkMax(patientId: string, maxUserId: string): Promise<boolean> {
  const p = await db.patient.findUnique({ where: { id: patientId }, select: { id: true, anonymizedAt: true } })
  if (!p || p.anonymizedAt) return false
  // один аккаунт MAX — один пациент: прежняя привязка этого user_id снимается
  await db.$transaction([
    db.patient.updateMany({ where: { maxUserId, NOT: { id: patientId } }, data: { maxUserId: null, maxLinkedAt: null } }),
    db.patient.update({ where: { id: patientId }, data: { maxUserId, maxLinkedAt: new Date() } }),
  ])
  return true
}

export async function unlinkMax(maxUserId: string): Promise<number> {
  const r = await db.patient.updateMany({ where: { maxUserId }, data: { maxUserId: null, maxLinkedAt: null } })
  return r.count
}
