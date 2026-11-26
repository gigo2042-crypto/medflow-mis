// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Реквизиты клиники для печатных форм, чеков и сообщений пациентам.
// Только из env (CLINIC_*). В production без них печать и чеки не выдаются;
// в демо — явно помеченные демонстрационные значения.
import { clinicRequisitesFrom } from '../../scripts/env-rules.mjs'

export interface ClinicRequisites {
  configured: boolean
  missing: string[]
  demo: boolean
  name: string
  shortName: string
  inn: string
  ogrn: string
  address: string
  phone: string
  license: string
}

export function clinic(): ClinicRequisites {
  return clinicRequisitesFrom(process.env) as ClinicRequisites
}

/** Название клиники для SMS/писем; если не задано — нейтральное «клиника» (ничего не выдумываем). */
export function clinicBrand(): string {
  const c = clinic()
  return c.shortName || 'клиника'
}

export class ClinicNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`Реквизиты клиники не заданы (${missing.join(', ')}) — печать документов и чеков недоступна`)
  }
}

/** Для печатных форм и чеков: бросает ошибку, если реквизиты не настроены. */
export function requireClinic(): ClinicRequisites {
  const c = clinic()
  if (!c.configured) throw new ClinicNotConfiguredError(c.missing)
  return c
}
