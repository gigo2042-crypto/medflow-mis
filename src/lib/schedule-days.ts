// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Загрузка исключений графика (праздники, отпуска, особые часы) для проверки слотов.
// Серверный модуль — не импортировать в клиентский код!
import { db } from '@/lib/db'
import { addDaysKey, dateKey } from '@/lib/mis-utils'
import { slotError, type DayException, type DoctorHours } from '@/lib/appointment-rules'

export async function exceptionsBetween(fromKey: string, toKey: string): Promise<DayException[]> {
  return db.scheduleException.findMany({ where: { date: { gte: fromKey, lte: toKey } } })
}

/** slotError с учётом исключений графика на дату слота. */
export async function checkSlot(doctor: DoctorHours, start: Date): Promise<string | null> {
  if (Number.isNaN(start.getTime())) return 'Неверная дата слота'
  const key = dateKey(start)
  return slotError(doctor, start, Date.now(), await exceptionsBetween(key, key))
}

/** Календарные даты (в поясе клиники) интервала [from, to). */
export function dayKeysBetween(from: Date, to: Date): string[] {
  const keys: string[] = []
  const last = dateKey(new Date(Math.max(from.getTime(), to.getTime() - 1)))
  for (let k = dateKey(from); k <= last && keys.length < 400; k = addDaysKey(k, 1)) keys.push(k)
  return keys
}
