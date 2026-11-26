// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Правила записей: допустимые переходы статусов и проверка слота.
// Общие для сервера и клиента (без обращения к БД).
import { clinicMinutes, dateKey, minutesOf, parseDateKey } from './mis-utils'

export const STATUS_TRANSITIONS: Record<string, string[]> = {
  BOOKED: ['CONFIRMED', 'ARRIVED', 'CANCELED', 'NO_SHOW'],
  CONFIRMED: ['ARRIVED', 'CANCELED', 'NO_SHOW'],
  ARRIVED: ['DONE', 'CANCELED'],
  DONE: [],
  CANCELED: [],
  NO_SHOW: [],
}

export function canTransition(from: string, to: string): boolean {
  return (STATUS_TRANSITIONS[from] || []).includes(to)
}

/** Перенос возможен только для ещё не начатого приёма. */
export function canReschedule(status: string): boolean {
  return status === 'BOOKED' || status === 'CONFIRMED'
}

export interface DoctorHours {
  id?: string
  workStart: string
  workEnd: string
  slotMinutes: number
  workDays?: string // Пн..Вс, «1» — рабочий день; по умолчанию Пн–Пт
}

export interface DayException {
  doctorId: string | null
  date: string
  kind: string // OFF | HOURS
  workStart: string | null
  workEnd: string | null
  reason: string | null
}

export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

/** Индекс дня недели (Пн = 0) календарной даты YYYY-MM-DD. */
export function weekdayOf(key: string): number {
  const k = parseDateKey(key)
  if (!k) return -1
  return (new Date(Date.UTC(k.y, k.m - 1, k.d)).getUTCDay() + 6) % 7
}

export type DayHours = { off: false; workStart: string; workEnd: string } | { off: true; reason: string }

/**
 * Часы работы врача в конкретный день с учётом графика (workDays) и исключений:
 * исключение врача важнее общего исключения клиники, оба важнее недельного графика.
 */
export function hoursOn(doctor: DoctorHours, key: string, exceptions: DayException[] = []): DayHours {
  const own = exceptions.find((e) => e.date === key && e.doctorId && e.doctorId === doctor.id)
  const clinicWide = exceptions.find((e) => e.date === key && !e.doctorId)
  const ex = own ?? clinicWide
  if (ex?.kind === 'OFF') return { off: true, reason: ex.reason || (own ? 'Врач не работает' : 'Нерабочий день клиники') }
  if (ex?.kind === 'HOURS' && ex.workStart && ex.workEnd) return { off: false, workStart: ex.workStart, workEnd: ex.workEnd }
  const mask = doctor.workDays || '1111100'
  const wd = weekdayOf(key)
  if (wd < 0 || mask[wd] !== '1') return { off: true, reason: 'Выходной по графику' }
  return { off: false, workStart: doctor.workStart, workEnd: doctor.workEnd }
}

/** Проверка слота в поясе клиники: null — слот корректен, иначе текст ошибки. */
export function slotError(doctor: DoctorHours, start: Date, now: number = Date.now(), exceptions: DayException[] = []): string | null {
  if (Number.isNaN(start.getTime())) return 'Неверная дата слота'
  if (start.getTime() <= now) return 'Нельзя записать на прошедшее время'
  const day = hoursOn(doctor, dateKey(start), exceptions)
  if (day.off) return `Нерабочий день: ${day.reason}`
  const minutes = clinicMinutes(start)
  const from = minutesOf(day.workStart)
  const to = minutesOf(day.workEnd)
  if (minutes < from || minutes + doctor.slotMinutes > to) return 'Слот вне рабочего времени врача'
  if ((minutes - from) % doctor.slotMinutes !== 0) return 'Слот не выровнен по сетке расписания'
  return null
}

/** Пропускная способность сетки (число слотов) врача по списку дат с учётом выходных и исключений. */
export function capacityOn(doctor: DoctorHours, keys: string[], exceptions: DayException[] = []): number {
  let total = 0
  for (const k of keys) {
    const h = hoursOn(doctor, k, exceptions)
    if (h.off) continue
    total += Math.max(0, Math.floor((minutesOf(h.workEnd) - minutesOf(h.workStart)) / doctor.slotMinutes))
  }
  return total
}
