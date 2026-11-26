// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Отчёты об ошибках в Sentry/GlitchTip (совместимый протокол). ВЫКЛЮЧЕНО по умолчанию:
// работает, только если задан SENTRY_DSN. Внешний сервис (sentry.io и т. п.) — только с
// SENTRY_EXTERNAL_ALLOWED=1 (проверка env при старте): текст ошибок чистится от ПДн
// эвристически, лучше self-hosted GlitchTip/Sentry внутри контура клиники.
// Отправляется: тип ошибки, очищенный текст, верх стека, режим и версия. Без запросов, cookie, тел.
import { scrubLogText } from '@/lib/log'
import { APP_VERSION } from '@/lib/version'
import { isLocalLlmUrl } from '../../scripts/env-rules.mjs'

export type Dsn = { endpoint: string; publicKey: string; host: string }

/** DSN вида https://<ключ>@<хост>[/путь]/<projectId> → адрес store-API. */
export function parseDsn(dsn: string | undefined): Dsn | null {
  if (!dsn) return null
  let u: URL
  try {
    u = new URL(dsn)
  } catch {
    return null
  }
  if (!['https:', 'http:'].includes(u.protocol) || !u.username) return null
  const parts = u.pathname.split('/').filter(Boolean)
  const project = parts.pop()
  if (!project || !/^\d+$/.test(project)) return null
  const prefix = parts.length ? '/' + parts.join('/') : ''
  return { endpoint: `${u.protocol}//${u.host}${prefix}/api/${project}/store/`, publicKey: decodeURIComponent(u.username), host: u.hostname }
}

/** true — DSN указывает за пределы контура (нужен SENTRY_EXTERNAL_ALLOWED=1). */
export function sentryIsExternal(dsn: string | undefined): boolean {
  const d = parseDsn(dsn)
  return !!d && !isLocalLlmUrl(`http://${d.host}`)
}

const g = globalThis as unknown as { __mfSentry?: { windowStart: number; sent: number; total: number; dropped: number } }
function state() {
  if (!g.__mfSentry) g.__mfSentry = { windowStart: 0, sent: 0, total: 0, dropped: 0 }
  return g.__mfSentry
}
export function errorReportStats() {
  const s = state()
  return { sent: s.total, dropped: s.dropped }
}

const MAX_PER_MINUTE = 30

/** Строит событие Sentry (без ПДн). Экспорт — для тестов. */
export function buildEvent(args: unknown[], env: Record<string, string | undefined> = process.env) {
  const err = args.find((a): a is Error => a instanceof Error)
  const text = scrubLogText(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : '')).filter(Boolean).join(' ')).slice(0, 1000)
  const frames = err?.stack
    ? err.stack.split('\n').slice(1, 15).map((l) => ({ function: scrubLogText(l.trim()).slice(0, 300) })).reverse()
    : undefined
  return {
    event_id: crypto.randomUUID().replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    level: 'error',
    platform: 'node',
    logger: 'medflow',
    environment: env.APP_MODE === 'demo' ? 'demo' : 'production',
    release: env.MEDFLOW_VERSION || APP_VERSION,
    message: text,
    exception: err ? { values: [{ type: err.name, value: scrubLogText(err.message).slice(0, 1000), stacktrace: frames ? { frames } : undefined }] } : undefined,
  }
}

/**
 * Отправить ошибку, если SENTRY_DSN задан. Не бросает исключений и не пишет в console
 * (иначе рекурсия через перехват console.error). Не больше 30 событий в минуту.
 */
export async function reportError(args: unknown[], env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const dsn = parseDsn(env.SENTRY_DSN)
  if (!dsn) return false
  if (sentryIsExternal(env.SENTRY_DSN) && !['1', 'true', 'yes'].includes(String(env.SENTRY_EXTERNAL_ALLOWED || '').toLowerCase())) return false
  const s = state()
  const now = Date.now()
  if (now - s.windowStart > 60_000) {
    s.windowStart = now
    s.sent = 0
  }
  if (s.sent >= MAX_PER_MINUTE) {
    s.dropped++
    return false
  }
  s.sent++
  try {
    const r = await fetchImpl(dsn.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_client=medflow/1, sentry_key=${dsn.publicKey}`,
      },
      body: JSON.stringify(buildEvent(args, env)),
      signal: AbortSignal.timeout(3000),
    })
    if (r.ok) s.total++
    else s.dropped++
    return r.ok
  } catch {
    s.dropped++
    return false
  }
}
