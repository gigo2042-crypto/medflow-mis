// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Сегменты пациентов для маркетинговых кампаний (чеклист п.14).
// Фильтр хранится в Segment.filterJson; в выборку попадают только пациенты
// с согласием на рекламные рассылки (marketingConsent).

export interface SegmentFilter {
  gender?: 'F' | 'M'
  ageFrom?: number
  ageTo?: number
  lastVisitMonthsMin?: number // давно не были: последний визит не позже N месяцев назад
  birthdayInDays?: number // день рождения в ближайшие N дней
  noShowMin?: number
}

export interface SegmentPatient {
  id: string
  gender: string
  birthDate: Date | null
  marketingConsent: boolean
  lastVisitAt: Date | null
  noShows: number
}

export function parseFilter(json: string | null | undefined): SegmentFilter {
  try {
    const raw = JSON.parse(json || '{}') as Record<string, unknown>
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined)
    return {
      gender: raw.gender === 'F' || raw.gender === 'M' ? raw.gender : undefined,
      ageFrom: num(raw.ageFrom),
      ageTo: num(raw.ageTo),
      lastVisitMonthsMin: num(raw.lastVisitMonthsMin),
      birthdayInDays: num(raw.birthdayInDays),
      noShowMin: num(raw.noShowMin),
    }
  } catch {
    return {}
  }
}

function ageAt(b: Date, now: Date): number {
  let a = now.getUTCFullYear() - b.getUTCFullYear()
  const m = now.getUTCMonth() - b.getUTCMonth()
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) a--
  return a
}

function daysToBirthday(b: Date, now: Date): number {
  const y = now.getUTCFullYear()
  let next = Date.UTC(y, b.getUTCMonth(), b.getUTCDate())
  const today = Date.UTC(y, now.getUTCMonth(), now.getUTCDate())
  if (next < today) next = Date.UTC(y + 1, b.getUTCMonth(), b.getUTCDate())
  return Math.round((next - today) / 86400_000)
}

export function matchesSegment(p: SegmentPatient, f: SegmentFilter, now = new Date()): boolean {
  if (!p.marketingConsent) return false
  if (f.gender && p.gender !== f.gender) return false
  if (f.ageFrom !== undefined || f.ageTo !== undefined) {
    if (!p.birthDate) return false
    const a = ageAt(p.birthDate, now)
    if (f.ageFrom !== undefined && a < f.ageFrom) return false
    if (f.ageTo !== undefined && a > f.ageTo) return false
  }
  if (f.lastVisitMonthsMin !== undefined) {
    const border = new Date(now)
    border.setUTCMonth(border.getUTCMonth() - f.lastVisitMonthsMin)
    if (p.lastVisitAt && p.lastVisitAt > border) return false
  }
  if (f.birthdayInDays !== undefined) {
    if (!p.birthDate || daysToBirthday(p.birthDate, now) > f.birthdayInDays) return false
  }
  if (f.noShowMin !== undefined && p.noShows < f.noShowMin) return false
  return true
}
