// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Чек-лист P1 «Мониторинг»: /api/metrics в формате Prometheus за токеном, структурные логи без ПДн,
// хук Sentry выключен по умолчанию и не уходит наружу без явного разрешения. Без сети: fetch подменён.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatLogLine, scrubLogText, logFormat, installStructuredLogging, logCounts } from '@/lib/log'
import { parseDsn, reportError, buildEvent, sentryIsExternal } from '@/lib/error-report'
import { metricsAuthorized, renderPrometheus } from '@/lib/metrics'
import { validateEnv } from '../../scripts/env-rules.mjs'

const PROD_OK = {
  APP_MODE: 'production', NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db:5432/m',
  SESSION_SECRET: 'a'.repeat(48), LINK_SECRET: 'l'.repeat(48), SERVICE_KEY: 's'.repeat(32), APP_URL: 'https://mis.example.test', WIDGET_ENABLED: '0',
}

describe('структурные логи', () => {
  it('строка — валидный JSON с ts/level/svc/msg, ошибка со стеком', () => {
    const e = new Error('сбой БД')
    const line = JSON.parse(formatLogLine('error', ['[payments POST]', e], new Date('2026-01-01T00:00:00Z')))
    expect(line).toMatchObject({ ts: '2026-01-01T00:00:00.000Z', level: 'error', svc: 'medflow' })
    expect(line.msg).toContain('[payments POST]')
    expect(line.err.name).toBe('Error')
    expect(line.err.stack).toContain('monitoring.test')
  })
  it('ПДн и секреты маскируются: телефон, email, СНИЛС, токен, пароль', () => {
    const s = scrubLogText('Иванов +7 (900) 123-45-67 ivan@example.test СНИЛС 112-233-445 95 token=abc123secret сессия 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')
    expect(s).not.toMatch(/123-45-67|ivan@example|112-233-445|abc123secret|9f86d081/)
    expect(s).toContain('[номер]')
    expect(s).toContain('[email]')
    expect(s).toContain('[скрыто]')
    expect(s).toContain('[токен]')
  })
  it('имена классов ошибок и id записей (cuid) не портятся', () => {
    expect(scrubLogText('PrismaClientKnownRequestError P2002 cmh1x2y3z0000abcdefghijkl')).toBe('PrismaClientKnownRequestError P2002 cmh1x2y3z0000abcdefghijkl')
  })
  it('формат: production — json по умолчанию, LOG_FORMAT переопределяет', () => {
    expect(logFormat({ NODE_ENV: 'production' })).toBe('json')
    expect(logFormat({ NODE_ENV: 'development' })).toBe('text')
    expect(logFormat({ NODE_ENV: 'production', LOG_FORMAT: 'text' })).toBe('text')
  })
  it('перехват console: JSON в stderr, счётчик ошибок, хук onError', () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => (writes.push(String(s)), true))
    const onError = vi.fn()
    const saved = { error: console.error, warn: console.warn, log: console.log, info: console.info, debug: console.debug }
    try {
      const before = logCounts().error
      installStructuredLogging({ onError, env: { NODE_ENV: 'production' } })
      console.error('[x] сбой у пациента +79001234567')
      expect(logCounts().error).toBe(before + 1)
      expect(onError).toHaveBeenCalledTimes(1)
      const line = JSON.parse(writes.at(-1)!)
      expect(line.level).toBe('error')
      expect(line.msg).not.toContain('79001234567')
    } finally {
      Object.assign(console, saved)
      spy.mockRestore()
    }
  })
})

describe('Sentry-хук', () => {
  afterEach(() => vi.restoreAllMocks())
  it('по умолчанию выключен: без SENTRY_DSN запросов нет', async () => {
    const f = vi.fn()
    expect(await reportError([new Error('x')], {}, f as never)).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })
  it('DSN разбирается в store-endpoint', () => {
    expect(parseDsn('https://pub123@glitchtip.clinic.local/7')).toEqual({ endpoint: 'https://glitchtip.clinic.local/api/7/store/', publicKey: 'pub123', host: 'glitchtip.clinic.local' })
    expect(parseDsn('https://pub@host.example/sub/12')?.endpoint).toBe('https://host.example/sub/api/12/store/')
    expect(parseDsn('not a dsn')).toBeNull()
    expect(parseDsn('https://host.example/1')).toBeNull()
  })
  it('внешний DSN без SENTRY_EXTERNAL_ALLOWED — не отправляется', async () => {
    const f = vi.fn()
    expect(sentryIsExternal('https://k@o1.ingest.sentry.io/5')).toBe(true)
    expect(await reportError([new Error('x')], { SENTRY_DSN: 'https://k@o1.ingest.sentry.io/5' }, f as never)).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })
  it('внутренний DSN: одно событие, без ПДн, с ключом в заголовке', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }))
    const ok = await reportError(['[visits PATCH]', new Error('пациент +7 900 111-22-33 не найден')], { SENTRY_DSN: 'https://pubkey@sentry.clinic.internal/3', APP_MODE: 'production' }, f as never)
    expect(ok).toBe(true)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://sentry.clinic.internal/api/3/store/')
    expect(String((init.headers as Record<string, string>)['x-sentry-auth'])).toContain('sentry_key=pubkey')
    expect(String(init.body)).not.toContain('111-22-33')
    expect(JSON.parse(String(init.body)).exception.values[0].type).toBe('Error')
  })
  it('событие не содержит запросов, cookie, пользователей', () => {
    const ev = buildEvent([new Error('x')], { APP_MODE: 'demo' }) as Record<string, unknown>
    expect(Object.keys(ev)).not.toEqual(expect.arrayContaining(['request']))
    expect(ev.user).toBeUndefined()
    expect(ev.environment).toBe('demo')
  })
  it('env: неверный DSN и внешний без разрешения — ошибка старта; внутренний — ок', () => {
    expect(validateEnv({ ...PROD_OK, SENTRY_DSN: 'nope' }).join()).toContain('SENTRY_DSN')
    expect(validateEnv({ ...PROD_OK, SENTRY_DSN: 'https://k@o1.ingest.sentry.io/5' }).join()).toContain('SENTRY_EXTERNAL_ALLOWED')
    expect(validateEnv({ ...PROD_OK, SENTRY_DSN: 'https://k@o1.ingest.sentry.io/5', SENTRY_EXTERNAL_ALLOWED: '1' })).toEqual([])
    expect(validateEnv({ ...PROD_OK, SENTRY_DSN: 'https://k@glitchtip.clinic.local/2' })).toEqual([])
  })
})

describe('/api/metrics', () => {
  it('без METRICS_TOKEN выключено, неверный/пустой токен — отказ, верный — ок', () => {
    const env = { METRICS_TOKEN: 'm'.repeat(32) }
    expect(metricsAuthorized('Bearer x', {})).toBe('disabled')
    expect(metricsAuthorized(null, env)).toBe('denied')
    expect(metricsAuthorized('Bearer ' + 'm'.repeat(31), env)).toBe('denied')
    expect(metricsAuthorized('Basic ' + 'm'.repeat(32), env)).toBe('denied')
    expect(metricsAuthorized('Bearer ' + 'm'.repeat(32), env)).toBe('ok')
  })
  it('формат Prometheus: HELP/TYPE, метки экранируются', () => {
    const t = renderPrometheus([{ name: 'medflow_x', help: 'тест', type: 'gauge', values: [{ labels: { status: 'a"b' }, value: 2 }, { value: NaN }] }])
    expect(t).toBe('# HELP medflow_x тест\n# TYPE medflow_x gauge\nmedflow_x{status="a\\"b"} 2\nmedflow_x 0\n')
  })
  it('env: короткий METRICS_TOKEN и неверный LOG_FORMAT — ошибка старта', () => {
    expect(validateEnv({ ...PROD_OK, METRICS_TOKEN: 'short' }).join()).toContain('METRICS_TOKEN')
    expect(validateEnv({ ...PROD_OK, LOG_FORMAT: 'xml' }).join()).toContain('LOG_FORMAT')
    expect(validateEnv({ ...PROD_OK, METRICS_TOKEN: 'm'.repeat(32), LOG_FORMAT: 'json' })).toEqual([])
  })
})
