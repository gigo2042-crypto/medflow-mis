// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Лимиты запросов в БД (таблица RateLimit): работают при нескольких инстансах
// приложения и переживают перезапуск — в отличие от Map в памяти процесса.
// Счётчик меняется ОДНИМ SQL-оператором (INSERT … ON CONFLICT DO UPDATE … RETURNING):
// параллельные запросы не теряют инкременты и не обходят лимит (чек-лист Тони, P0).
import { db } from '@/lib/db'

export interface RateResult {
  allowed: boolean
  retryAfterSec: number
}

/** Проверка без записи: заблокирован ли ключ сейчас. */
export async function isLocked(key: string): Promise<RateResult> {
  const r = await db.rateLimit.findUnique({ where: { key } })
  if (r?.lockedUntil && r.lockedUntil.getTime() > Date.now()) {
    return { allowed: false, retryAfterSec: Math.ceil((r.lockedUntil.getTime() - Date.now()) / 1000) }
  }
  return { allowed: true, retryAfterSec: 0 }
}

/**
 * Засчитать событие (неудачную попытку / запрос) по ключу.
 * Больше limit событий за windowMs — блокировка на lockMs. Атомарно.
 */
export async function hit(key: string, limit: number, windowMs: number, lockMs: number): Promise<RateResult> {
  // Время приложения (UTC) передаётся параметром: колонки — timestamp без зоны, хранят UTC
  const now = new Date()
  const nowIso = now.toISOString()
  const windowStartMin = new Date(now.getTime() - windowMs).toISOString()
  const lockUntil = new Date(now.getTime() + lockMs).toISOString()
  const rows = await db.$queryRaw<Array<{ count: number; lockedUntil: Date | null; wasLocked: boolean }>>`
    INSERT INTO "RateLimit" ("key", "count", "windowStart", "lockedUntil")
    VALUES (${key}, 1, ${nowIso}::timestamp, CASE WHEN 1 > ${limit} THEN ${lockUntil}::timestamp ELSE NULL END)
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimit"."lockedUntil" > ${nowIso}::timestamp THEN "RateLimit"."count"
        WHEN "RateLimit"."windowStart" < ${windowStartMin}::timestamp THEN 1
        ELSE "RateLimit"."count" + 1 END,
      "windowStart" = CASE
        WHEN "RateLimit"."lockedUntil" > ${nowIso}::timestamp THEN "RateLimit"."windowStart"
        WHEN "RateLimit"."windowStart" < ${windowStartMin}::timestamp THEN ${nowIso}::timestamp
        ELSE "RateLimit"."windowStart" END,
      "lockedUntil" = CASE
        WHEN "RateLimit"."lockedUntil" > ${nowIso}::timestamp THEN "RateLimit"."lockedUntil"
        WHEN "RateLimit"."windowStart" < ${windowStartMin}::timestamp THEN CASE WHEN 1 > ${limit} THEN ${lockUntil}::timestamp ELSE NULL END
        WHEN "RateLimit"."count" + 1 > ${limit} THEN ${lockUntil}::timestamp
        ELSE NULL END
    RETURNING "count", "lockedUntil", ("lockedUntil" IS NOT NULL AND "lockedUntil" < ${lockUntil}::timestamp) AS "wasLocked"`
  const r = rows[0]
  if (r?.lockedUntil) {
    const until = new Date(r.lockedUntil).getTime()
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((until - now.getTime()) / 1000)) }
  }
  return { allowed: true, retryAfterSec: 0 }
}

export async function resetLimit(key: string): Promise<void> {
  await db.rateLimit.deleteMany({ where: { key } })
}

/** Снять блокировки по префиксу ключа (CLI unlock). Возвращает число снятых записей. */
export async function resetLimitsByPrefix(prefix: string): Promise<number> {
  const r = await db.rateLimit.deleteMany({ where: { key: { startsWith: prefix } } })
  return r.count
}
