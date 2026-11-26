// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Доступ к персональным (ПДн) и медицинским данным по ролям — единые правила для API.
// Врачебная тайна (323-ФЗ ст.13) и минимизация ПДн (152-ФЗ ст.5):
//  • ПДн пациента (ФИО, телефон, карта) — только роли с patients.read;
//  • медданные (жалобы, протоколы, диагнозы, результаты анализов, AI-сводка) — только medical.read
//    (врач, администратор);
//  • врач по умолчанию видит только своих пациентов (DOCTOR_SCOPE=own). DOCTOR_SCOPE=all —
//    видит записи коллег, но без телефонов чужих пациентов.
import { db } from '@/lib/db'
import { hasPerm } from '@/lib/rbac'

export interface PdUser {
  role: string
  doctorId: string | null
}

export type PatientAccess = 'full' | 'name' | 'none'

export function canSeePd(u: Pick<PdUser, 'role'>): boolean {
  return hasPerm(u.role, 'patients.read')
}

export function canSeeMedical(u: Pick<PdUser, 'role'>): boolean {
  return hasPerm(u.role, 'medical.read')
}

/** Режим видимости для врачей: own (по умолчанию) | all. */
export function doctorScope(): 'own' | 'all' {
  return process.env.DOCTOR_SCOPE === 'all' ? 'all' : 'own'
}

/** id врача, которым нужно ограничить выборку (только врач в режиме own), иначе null. */
export function doctorFilterId(u: PdUser): string | null {
  if (u.role !== 'DOCTOR' || doctorScope() === 'all') return null
  // врач без привязки к карточке не видит ничьих пациентов
  return u.doctorId ?? '__no_doctor__'
}

/** Что можно показать о пациенте записи врача doctorId. */
export function patientAccessFor(u: PdUser, doctorId: string | null | undefined): PatientAccess {
  if (!canSeePd(u)) return 'none'
  if (u.role !== 'DOCTOR') return 'full'
  if (doctorId && u.doctorId === doctorId) return 'full'
  return doctorScope() === 'all' ? 'name' : 'none'
}

/** Может ли пользователь открыть карточку/историю пациента. Врач (own) — только если пациент записан к нему. */
export async function canAccessPatient(u: PdUser, patientId: string): Promise<boolean> {
  if (!canSeePd(u)) return false
  const doc = doctorFilterId(u)
  if (!doc) return true
  const n = await db.appointment.count({ where: { patientId, doctorId: doc } })
  return n > 0
}

export const HIDDEN = 'скрыто'

/** +7 *** ***-**-12 — для журналов без права на ПДн. */
export function maskPhone(phone: string | null | undefined): string {
  const d = String(phone || '').replace(/\D/g, '')
  if (d.length < 4) return '***'
  return `+${d[0]} *** ***-**-${d.slice(-2)}`
}

export function maskEmail(email: string | null | undefined): string {
  const s = String(email || '')
  const at = s.indexOf('@')
  if (at < 1) return '***'
  return `${s[0]}***${s.slice(at)}`
}

/** Убрать медицинские поля визита для ролей без medical.read. */
export function stripMedical<T extends Record<string, unknown>>(v: T, allowed: boolean): T {
  if (allowed) return v
  return {
    ...v,
    complaints: null,
    protocolText: null,
    templateData: null,
    diagnosisCode: null,
    diagnosisName: null,
  }
}
