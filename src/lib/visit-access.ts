// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import type { AuthUser } from '@/lib/auth-server'

/** Врач работает только со своими приёмами; администратор — со всеми (чеклист п.6). */
export function canEditVisitOf(user: Pick<AuthUser, 'role' | 'doctorId'>, visitDoctorId: string): boolean {
  if (user.role === 'ADMIN') return true
  if (user.role === 'DOCTOR') return Boolean(user.doctorId) && user.doctorId === visitDoctorId
  return false
}
