// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { Me, permsOf, tabsOf, Role } from '@/lib/rbac'
import { appMode, clinicTz } from '@/lib/config'

export function toMe(u: { id: string; login: string; name: string; role: string; doctorId?: string | null; totpEnabled?: boolean }): Me {
  return {
    id: u.id,
    login: u.login,
    name: u.name,
    role: u.role as Role,
    perms: permsOf(u.role),
    tabs: tabsOf(u.role),
    doctorId: u.doctorId ?? null,
    clinicTz: clinicTz(),
    mode: appMode(),
    totpEnabled: Boolean(u.totpEnabled),
  }
}
