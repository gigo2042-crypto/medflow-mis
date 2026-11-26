// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Подписанные ссылки для пациента (без входа в систему):
//   ap   — ответ по приёму (подтвердить / отменить) из напоминания или касания по риску
//   wl   — ответ на приглашение из листа ожидания (записаться / не подходит)
//   u    — отписка от рекламных рассылок
//   max  — payload для диплинка бота MAX (привязка пациента к user_id)
// Подпись — HMAC-SHA256 на отдельном LINK_SECRET (чек-лист P1: ротация SESSION_SECRET больше не ломает
// ссылки в SMS, и наоборот), усечённая до 96 бит. В токене — время выпуска (минуты, base36): срок жизни
// по виду ссылки задаётся env (LINK_TTL_<ВИД>_DAYS) и проверяется при каждом открытии; отзыв — таблица
// LinkRevocation (src/lib/link-revocation.ts, CLI revoke-links) и ротация LINK_SECRET (старый ключ можно
// временно оставить в LINK_SECRET_PREVIOUS).
// Входящих SMS (ответ «1»/«2», «СТОП») SMS-шлюз не принимает — поэтому ответы идут по ссылке
// (SMS) или кнопками (MAX).
import { createHmac, timingSafeEqual } from 'crypto'

export type LinkKind = 'ap' | 'wl' | 'u' | 'max'
const KINDS: LinkKind[] = ['ap', 'wl', 'u', 'max']

// Срок жизни по умолчанию, дней: ответ по приёму — 30, лист ожидания — 7 (предложение и так 15 минут),
// отписка — 400 (38-ФЗ: отказ от рассылки должен работать долго), приглашение в MAX — 30
const DEFAULT_TTL_DAYS: Record<LinkKind, number> = { ap: 30, wl: 7, u: 400, max: 30 }

export function linkTtlDays(kind: LinkKind): number {
  const v = Number(process.env[`LINK_TTL_${kind.toUpperCase()}_DAYS`])
  return Number.isFinite(v) && v > 0 && v <= 3650 ? v : DEFAULT_TTL_DAYS[kind]
}

function isProduction(): boolean {
  return (process.env.APP_MODE || 'production') !== 'demo'
}

/** Ключи подписи: текущий и (для плавной ротации) предыдущий. */
function secrets(): string[] {
  const cur = process.env.LINK_SECRET
  const prev = process.env.LINK_SECRET_PREVIOUS
  if (cur) return prev ? [cur, prev] : [cur]
  // без LINK_SECRET — только демо/тесты: ключ выводится из SESSION_SECRET (в production старт не пройдёт)
  const s = process.env.SESSION_SECRET
  if (!s || isProduction() && process.env.NODE_ENV === 'production') {
    throw new Error('[medflow] LINK_SECRET не задан — подписанные ссылки недоступны')
  }
  return [createHmac('sha256', s).update('medflow-link-secret-fallback').digest('hex')]
}

function mac(body: string, key: string): string {
  return createHmac('sha256', key).update(`patient-link:v2:${body}`).digest('base64url').slice(0, 16)
}

/** Токен вида <kind>_<id>_<выпуск>_<mac>: только [A-Za-z0-9_-], ≤ 128 символов (лимит payload диплинка MAX). */
export function signLink(kind: LinkKind, id: string, now = new Date()): string {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('Недопустимый id для ссылки')
  const iss = Math.floor(now.getTime() / 60_000).toString(36)
  const body = `${kind}_${id}_${iss}`
  return `${body}_${mac(body, secrets()[0])}`
}

export interface VerifiedLink {
  kind: LinkKind
  id: string
  issuedAt: Date
  expiresAt: Date
}

/** Проверка подписи и срока жизни (без БД). Отзыв — checkLink в src/lib/link-revocation.ts. */
export function verifyLink(token: string | null | undefined, now = new Date()): VerifiedLink | null {
  if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return null
  // подпись — последние 16 символов base64url (может содержать «_» и «-»), разбор по позициям
  if (token.length < 24 || token[token.length - 17] !== '_') return null
  const body = token.slice(0, -17)
  const sig = token.slice(-16)
  const parts = body.split('_')
  if (parts.length !== 3) return null
  const [kindRaw, id, iss] = parts
  const kind = kindRaw as LinkKind
  if (!KINDS.includes(kind) || !/^[A-Za-z0-9-]+$/.test(id) || !/^[0-9a-z]{1,10}$/.test(iss)) return null
  const a = Buffer.from(sig)
  const ok = secrets().some((key) => {
    const b = Buffer.from(mac(body, key))
    return a.length === b.length && timingSafeEqual(a, b)
  })
  if (!ok) return null
  const issuedAt = new Date(parseInt(iss, 36) * 60_000)
  const expiresAt = new Date(issuedAt.getTime() + linkTtlDays(kind) * 86400_000)
  // выпуск «из будущего» (больше 5 минут) — не наш токен
  if (issuedAt.getTime() > now.getTime() + 5 * 60_000 || expiresAt.getTime() <= now.getTime()) return null
  return { kind, id, issuedAt, expiresAt }
}

function baseUrl(): string {
  return (process.env.APP_URL || '').replace(/\/+$/, '')
}

/** Публичная ссылка на страницу ответа пациента. */
export function patientLink(kind: Exclude<LinkKind, 'max'>, id: string): string {
  return `${baseUrl()}/r/${signLink(kind, id)}`
}
