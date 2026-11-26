// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Утилиты МИС MedFlow — общие для сервера и клиента

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

// ---- Часовой пояс клиники ----
// Все времена приёмов хранятся в UTC, а показываются и считаются в поясе клиники
// (CLINIC_TZ, по умолчанию Europe/Moscow) — независимо от пояса сервера и браузера.
let CLINIC_TZ: string =
  (typeof process !== 'undefined' && process.env && process.env.CLINIC_TZ) || 'Europe/Moscow'

export function setClinicTz(tz: string): void {
  if (tz) CLINIC_TZ = tz
}

export function getClinicTz(): string {
  return CLINIC_TZ
}

export interface ZonedParts {
  year: number
  month: number // 1..12
  day: number
  hour: number
  minute: number
  second: number
  weekday: number // 0 = Пн … 6 = Вс
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    fmtCache.set(tz, f)
  }
  return f
}

const WD: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }

export function zonedParts(d: Date, tz: string = CLINIC_TZ): ZonedParts {
  const out: Record<string, string> = {}
  for (const p of fmtFor(tz).formatToParts(d)) out[p.type] = p.value
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WD[out.weekday] ?? 0,
  }
}

/** Смещение пояса относительно UTC в мс для момента d. */
export function tzOffsetMs(d: Date, tz: string = CLINIC_TZ): number {
  const p = zonedParts(d, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(d.getTime() / 1000) * 1000
}

/** Момент времени для «настенного» времени в поясе клиники (учитывает переходы на летнее время). */
export function zonedTime(year: number, month: number, day: number, hour = 0, minute = 0, tz: string = CLINIC_TZ): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  let ts = guess - tzOffsetMs(new Date(guess), tz)
  const off2 = tzOffsetMs(new Date(ts), tz)
  ts = guess - off2
  return new Date(ts)
}

/** YYYY-MM-DD в поясе клиники. */
export function dateKey(d: Date, tz: string = CLINIC_TZ): string {
  const p = zonedParts(d, tz)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`
}

/** Разбор YYYY-MM-DD; null — неверный формат. */
export function parseDateKey(key: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '')
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return { y, m: mo, d }
}

/** Границы суток (в поясе клиники) для YYYY-MM-DD: [начало, начало следующих суток). */
export function dayRangeOf(key: string, tz: string = CLINIC_TZ): { gte: Date; lt: Date } | null {
  const k = parseDateKey(key)
  if (!k) return null
  const next = addDaysKey(key, 1)
  const n = parseDateKey(next)!
  return { gte: zonedTime(k.y, k.m, k.d, 0, 0, tz), lt: zonedTime(n.y, n.m, n.d, 0, 0, tz) }
}

/** Сдвиг даты YYYY-MM-DD на n дней (календарно, без учёта пояса). */
export function addDaysKey(key: string, n: number): string {
  const k = parseDateKey(key)
  if (!k) return key
  const t = new Date(Date.UTC(k.y, k.m - 1, k.d + n))
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`
}

/** HH:MM в поясе клиники. */
export function timeStr(d: Date, tz: string = CLINIC_TZ): string {
  const p = zonedParts(d, tz)
  return `${pad2(p.hour)}:${pad2(p.minute)}`
}

/** Минуты от полуночи в поясе клиники. */
export function clinicMinutes(d: Date, tz: string = CLINIC_TZ): number {
  const p = zonedParts(d, tz)
  return p.hour * 60 + p.minute
}

/** ДД.ММ в поясе клиники. */
export function ddmm(d: Date, tz: string = CLINIC_TZ): string {
  const p = zonedParts(d, tz)
  return `${pad2(p.day)}.${pad2(p.month)}`
}

/** ДД.ММ.ГГГГ в поясе клиники. */
export function ddmmyyyy(d: Date, tz: string = CLINIC_TZ): string {
  const p = zonedParts(d, tz)
  return `${pad2(p.day)}.${pad2(p.month)}.${p.year}`
}

/** ДД.ММ ЧЧ:ММ в поясе клиники. */
export function ddmmHHMM(d: Date, tz: string = CLINIC_TZ): string {
  return `${ddmm(d, tz)} ${timeStr(d, tz)}`
}

/** ЧЧ:ММ:СС в поясе клиники (часы в шапке). */
export function clockStr(d: Date, tz: string = CLINIC_TZ): string {
  const p = zonedParts(d, tz)
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`
}

/** Полная дата для подписи дня («среда, 25 ноября») в поясе клиники. */
export function longDayLabel(key: string, tz: string = CLINIC_TZ): string {
  const k = parseDateKey(key)
  if (!k) return key
  return zonedTime(k.y, k.m, k.d, 12, 0, tz).toLocaleDateString('ru-RU', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' })
}

export function minutesOf(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

export function hhmm(totalMinutes: number): string {
  return `${pad2(Math.floor(totalMinutes / 60))}:${pad2(totalMinutes % 60)}`
}

// Расстояние Левенштейна — устойчивый к опечаткам поиск пациентов (точка улучшения №1)
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const curr = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = curr
  }
  return prev[n]
}

/** Телефон → только цифры в формате 7XXXXXXXXXX для российских номеров: 8… и 9… (10 цифр) приводятся к 7…
 *  (иначе +7 900… и 8 900… считались разными людьми). Совпадает с SQL-функцией mf_phone_norm. */
export function normalizePhone(s: string): string {
  let d = (s || '').replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`
  else if (d.length === 10 && d.startsWith('9')) d = `7${d}`
  return d
}

// Предиктивный скор риска неявки (точка улучшения №4)
export function riskScore(pastNoShows: number, source: string, hoursUntil: number): number {
  let s = pastNoShows * 25
  if (source === 'PHONE') s += 15
  if (source === 'WIDGET') s += 5
  if (hoursUntil < 1) s += 10
  else if (hoursUntil < 3) s += 5
  return Math.min(90, s)
}

export function riskLabel(s: number): string {
  return s >= 50 ? 'Высокий' : s >= 25 ? 'Средний' : 'Низкий'
}

export function riskClass(s: number): string {
  return s >= 50 ? 'bg-rose-100 text-rose-700' : s >= 25 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
}

export function riskHint(s: number): string {
  if (s >= 50) return 'Позвонить и подтвердить запись, предложить перенос из листа ожидания'
  if (s >= 25) return 'Отправить напоминание в мессенджер за 2 часа'
  return 'Стандартное напоминание накануне'
}

// Статус бейджа приёма
export function statusClass(status: string): string {
  switch (status) {
    case 'DONE':
      return 'bg-emerald-100 text-emerald-700'
    case 'ARRIVED':
      return 'bg-amber-100 text-amber-700'
    case 'CONFIRMED':
      return 'bg-teal-100 text-teal-700'
    case 'BOOKED':
      return 'bg-slate-100 text-slate-700'
    case 'CANCELED':
      return 'bg-slate-100 text-slate-400'
    case 'NO_SHOW':
      return 'bg-rose-100 text-rose-700'
    default:
      return 'bg-slate-100 text-slate-600'
  }
}

// ---- Concurrent-лицензирование ----
export const LICENSE_LIMIT = 3 // одновременных рабочих мест в демо-лицензии
export const IDLE_RELEASE_SECONDS = 300 // авто-освобождение простоя, 5 минут
export const RELEASE_WARNING_SECONDS = 60 // предупреждение перед вытеснением

export function formatIdle(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m} мин ${pad2(s)} с` : `${s} с`
}

export function ageFromBirthDate(bd: string | null): string {
  if (!bd) return 'возраст не указан'
  const b = new Date(bd)
  const now = new Date()
  let age = now.getFullYear() - b.getFullYear()
  const md = (now.getMonth() - b.getMonth()) || (now.getDate() - b.getDate())
  if (md < 0) age--
  return `${age} ${age % 10 === 1 && age % 100 !== 11 ? 'год' : age % 10 >= 2 && age % 10 <= 4 && (age % 100 < 10 || age % 100 >= 20) ? 'года' : 'лет'}`
}

/** Сегодняшняя дата YYYY-MM-DD в поясе клиники. */
export function todayKey(tz: string = CLINIC_TZ): string {
  return dateKey(new Date(), tz)
}

/** Начало суток (в поясе клиники) со сдвигом offsetDays от сегодняшнего дня. */
export function clinicDayStart(offsetDays = 0, tz: string = CLINIC_TZ): Date {
  return dayRangeOf(addDaysKey(todayKey(tz), offsetDays), tz)!.gte
}

/** Начало суток (в поясе клиники), содержащих момент d. */
export function clinicDayStartOf(d: Date, tz: string = CLINIC_TZ): Date {
  return dayRangeOf(dateKey(d, tz), tz)!.gte
}
