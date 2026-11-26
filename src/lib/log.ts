// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Структурные логи: в production каждая строка stdout/stderr — JSON-объект
// {ts, level, svc, msg, err?}. Собираются docker json-file / journald / Loki без парсинга.
// Перед записью текст чистится от типовых ПДн и секретов (телефоны, email, длинные числа,
// токены): логи уходят в системы, где ПДн не место. LOG_FORMAT=text — прежний вывод.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// телефоны и прочие длинные номера (СНИЛС, полис, паспорт): 7+ цифр с разделителями
const PHONE_RE = /(?<![\w])\+?\d[\d\s()-]{5,}\d(?![\w])/g
// токены: hex 32+ или base64url 32+ с цифрами и буквами (сессии, ссылки пациента); cuid записей (25) и имена классов не трогаем
const TOKEN_RE = /\b(?:[a-f0-9]{32,}|(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,})\b/g
const BEARER_RE = /(bearer|token|key|secret|password|passwd|pwd)(["'\s:=]+)([^\s"',;]+)/gi

/** Маскирует ПДн и секреты в строке лога. Не заменяет дисциплину «не логировать ПДн». */
export function scrubLogText(s: string): string {
  return String(s)
    .replace(BEARER_RE, (_m, k, sep) => `${k}${sep}[скрыто]`)
    .replace(EMAIL_RE, '[email]')
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 7 ? '[номер]' : m))
    .replace(TOKEN_RE, '[токен]')
}

function errOf(e: unknown): { name: string; message: string; stack?: string } | undefined {
  if (!(e instanceof Error)) return undefined
  return {
    name: e.name,
    message: scrubLogText(e.message).slice(0, 2000),
    stack: e.stack ? scrubLogText(e.stack).split('\n').slice(0, 12).join('\n') : undefined,
  }
}

function argText(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.message
  try {
    return JSON.stringify(a)
  } catch {
    return String(a)
  }
}

/** Одна строка JSON для набора аргументов console.*. */
export function formatLogLine(level: LogLevel, args: unknown[], now = new Date()): string {
  const err = args.map(errOf).find(Boolean)
  const msg = scrubLogText(args.map(argText).join(' ')).slice(0, 4000)
  const line: Record<string, unknown> = { ts: now.toISOString(), level, svc: 'medflow', msg }
  if (err) line.err = err
  return JSON.stringify(line)
}

type Counts = { error: number; warn: number }
const g = globalThis as unknown as { __mfLogCounts?: Counts; __mfLogInstalled?: boolean }

/** Счётчики сообщений по уровням — для /api/metrics. */
export function logCounts(): Counts {
  if (!g.__mfLogCounts) g.__mfLogCounts = { error: 0, warn: 0 }
  return g.__mfLogCounts
}

export function logFormat(env: Record<string, string | undefined> = process.env): 'json' | 'text' {
  if (env.LOG_FORMAT === 'text') return 'text'
  if (env.LOG_FORMAT === 'json') return 'json'
  return env.NODE_ENV === 'production' ? 'json' : 'text'
}

/**
 * Перехватывает console.* процесса: считает ошибки/предупреждения, в формате json пишет
 * строки JSON, ошибки передаёт onError (хук Sentry). Повторный вызов ничего не делает.
 */
export function installStructuredLogging(opts: { onError?: (args: unknown[]) => void; env?: Record<string, string | undefined> } = {}) {
  if (g.__mfLogInstalled) return
  g.__mfLogInstalled = true
  const json = logFormat(opts.env) === 'json'
  const out = (s: string) => process.stdout.write(s + '\n')
  const errOut = (s: string) => process.stderr.write(s + '\n')
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
  const wrap = (level: LogLevel, base: (...a: unknown[]) => void, write: (s: string) => void) =>
    (...args: unknown[]) => {
      if (level === 'error') logCounts().error++
      if (level === 'warn') logCounts().warn++
      if (json) write(formatLogLine(level, args))
      else base(...args)
      if (level === 'error' && opts.onError) {
        try {
          opts.onError(args)
        } catch {
          /* хук отчёта об ошибках не должен ронять логирование */
        }
      }
    }
  console.log = wrap('info', orig.log, out)
  console.info = wrap('info', orig.info, out)
  console.debug = wrap('debug', orig.debug, out)
  console.warn = wrap('warn', orig.warn, errOut)
  console.error = wrap('error', orig.error, errOut)
}
