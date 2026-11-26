// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Справочник МКБ-10 в БД (таблица IcdCode, загрузка из НСИ). Пока таблица пуста —
// встроенный краткий список (только демо). Серверный модуль.
import { db } from '@/lib/db'
import { ICD_LIST, type IcdEntry } from '@/lib/icd'
import { ASSIGNABLE_ICD_RE } from '@/lib/icd-import'

let loadedCache: { at: number; count: number } | null = null

async function referenceLoaded(): Promise<boolean> {
  if (loadedCache && Date.now() - loadedCache.at < 60_000) return loadedCache.count > 0
  const count = await db.icdCode.count()
  loadedCache = { at: Date.now(), count }
  return count > 0
}

/** Код для диагноза: существует, актуален, это рубрика/подрубрика (не диапазон). */
export async function resolveIcd(code: string | null | undefined): Promise<IcdEntry | null> {
  if (!code) return null
  const c = String(code).trim().toUpperCase()
  if (!ASSIGNABLE_ICD_RE.test(c)) return null
  if (await referenceLoaded()) {
    const r = await db.icdCode.findUnique({ where: { code: c } })
    return r && r.actual ? { code: r.code, name: r.name } : null
  }
  return ICD_LIST.find((e) => e.code === c) ?? null
}

export async function searchIcdDb(query: string, limit = 10): Promise<{ items: IcdEntry[]; source: 'NSI' | 'BUILTIN' }> {
  const q = query.trim()
  if (!q) return { items: [], source: 'BUILTIN' }
  if (await referenceLoaded()) {
    const upper = q.toUpperCase()
    const byCode = await db.icdCode.findMany({ where: { actual: true, code: { startsWith: upper } }, orderBy: { code: 'asc' }, take: limit })
    const byName = byCode.length >= limit ? [] : await db.icdCode.findMany({ where: { actual: true, name: { contains: q, mode: 'insensitive' } }, orderBy: { code: 'asc' }, take: limit * 3 })
    const all = [...byCode, ...byName.filter((n) => !byCode.some((c) => c.code === n.code))]
    return { items: all.filter((e) => ASSIGNABLE_ICD_RE.test(e.code)).slice(0, limit).map((e) => ({ code: e.code, name: e.name })), source: 'NSI' }
  }
  const { searchIcd } = await import('@/lib/icd')
  return { items: searchIcd(q, limit), source: 'BUILTIN' }
}
