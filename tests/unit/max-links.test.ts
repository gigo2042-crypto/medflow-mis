// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Регрессия: WhatsApp заменён MAX (адаптер по документации dev.max.ru, без живых вызовов);
// ответы пациента — подписанные ссылки (входящие SMS не поддерживаются). Только фейковые данные.
import { beforeEach, describe, expect, it } from 'vitest'
import { buildMaxMessage, maxConfig, maxDeeplink, sendMaxMessage, answerMaxCallback } from '@/lib/max'
import { patientLink, signLink, verifyLink } from '@/lib/patient-links'

process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefgh'
const MAX_ENV = { MAX_BOT_TOKEN: 'fake-bot-token', MAX_BOT_NAME: 'test_clinic_bot', MAX_WEBHOOK_SECRET: 'fake_secret-123', MAX_API_URL: 'https://max.mock' }

describe('Подписанные ссылки пациента', () => {
  it('подпись проверяется, подделка и чужой вид отклоняются', () => {
    const t = signLink('ap', 'cmappt0001')
    expect(verifyLink(t)).toMatchObject({ kind: 'ap', id: 'cmappt0001' })
    expect(verifyLink(t.replace('cmappt0001', 'cmappt0002'))).toBeNull()
    expect(verifyLink(t.replace(/^ap_/, 'u_'))).toBeNull()
    expect(verifyLink(`${t}x`)).toBeNull()
    expect(verifyLink('')).toBeNull()
  })
  it('разбор устойчив к «_» и «-» в подписи (200 случайных id)', () => {
    for (let i = 0; i < 200; i++) {
      const id = `c${Math.random().toString(36).slice(2)}${i}`
      expect(verifyLink(signLink('wl', id))).toMatchObject({ kind: 'wl', id })
    }
  })
  it('payload для диплинка MAX: ≤128 символов и только [A-Za-z0-9_-]', () => {
    const t = signLink('max', 'c'.repeat(25))
    expect(t.length).toBeLessThanOrEqual(128)
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
  })
  it('ссылка ведёт на /r/<токен> публичного адреса', () => {
    process.env.APP_URL = 'https://mis.example.test/'
    expect(patientLink('u', 'cmpat0001')).toMatch(/^https:\/\/mis\.example\.test\/r\/u_cmpat0001_[0-9a-z]+_[A-Za-z0-9_-]{16}$/)
  })
})

describe('LINK_SECRET, срок жизни и ротация (чек-лист P1)', () => {
  const save = { ...process.env }
  beforeEach(() => {
    for (const k of ['LINK_SECRET', 'LINK_SECRET_PREVIOUS', 'LINK_TTL_AP_DAYS', 'LINK_TTL_U_DAYS']) delete process.env[k]
  })
  it('подпись на LINK_SECRET: смена SESSION_SECRET ссылку не ломает, смена LINK_SECRET — ломает', () => {
    process.env.LINK_SECRET = 'link-secret-A-0123456789-abcdefghijkl'
    const t = signLink('ap', 'cmappt0001')
    process.env.SESSION_SECRET = 'another-session-secret-0123456789-xyz'
    expect(verifyLink(t)).not.toBeNull()
    process.env.LINK_SECRET = 'link-secret-B-0123456789-abcdefghijkl'
    expect(verifyLink(t)).toBeNull()
    process.env.LINK_SECRET_PREVIOUS = 'link-secret-A-0123456789-abcdefghijkl'
    expect(verifyLink(t)).not.toBeNull() // плавная ротация
    process.env.SESSION_SECRET = save.SESSION_SECRET
  })
  it('срок жизни по виду ссылки; истёкшая и «из будущего» — недействительны', () => {
    process.env.LINK_SECRET = 'link-secret-A-0123456789-abcdefghijkl'
    const day = 86400_000
    const old = signLink('ap', 'cmappt0001', new Date(Date.now() - 31 * day))
    expect(verifyLink(old)).toBeNull() // ap — 30 дней
    expect(verifyLink(signLink('ap', 'cmappt0001', new Date(Date.now() - 29 * day)))).not.toBeNull()
    expect(verifyLink(signLink('u', 'cmpat0001', new Date(Date.now() - 300 * day)))).not.toBeNull() // отписка — 400 дней
    process.env.LINK_TTL_AP_DAYS = '1'
    expect(verifyLink(signLink('ap', 'cmappt0001', new Date(Date.now() - 2 * day)))).toBeNull() // срок сокращается задним числом
    expect(verifyLink(signLink('ap', 'cmappt0001', new Date(Date.now() + 60 * 60_000)))).toBeNull()
  })
  it('старый формат (без времени выпуска) не принимается', () => {
    expect(verifyLink('ap_cmappt0001_AAAAAAAAAAAAAAAA')).toBeNull()
  })
  it('env-rules: в production LINK_SECRET обязателен и не равен SESSION_SECRET', async () => {
    const { validateEnv } = await import('../../scripts/env-rules.mjs')
    const base = { APP_MODE: 'production', DATABASE_URL: 'postgresql://u:p@h/db', SESSION_SECRET: 's'.repeat(40), SERVICE_KEY: 'k'.repeat(30), APP_URL: 'https://mis.example.test' }
    expect(validateEnv(base).join('\n')).toMatch(/LINK_SECRET/)
    expect(validateEnv({ ...base, LINK_SECRET: 's'.repeat(40) }).join('\n')).toMatch(/LINK_SECRET/)
    expect(validateEnv({ ...base, LINK_SECRET: 'l'.repeat(40) }).join('\n')).not.toMatch(/LINK_SECRET/)
    expect(validateEnv({ ...base, APP_MODE: 'demo' }).join('\n')).not.toMatch(/LINK_SECRET/)
  })
})

describe('MAX Bot API адаптер', () => {
  beforeEach(() => {
    for (const k of Object.keys(MAX_ENV)) delete process.env[k]
  })

  it('без токена — не настроен, с понятной причиной', () => {
    const c = maxConfig({})
    expect(c.configured).toBe(false)
    expect(c.problem).toMatch(/MAX_BOT_TOKEN/)
  })
  it('секрет вебхука проверяется по формату из документации', () => {
    expect(maxConfig({ ...MAX_ENV, MAX_WEBHOOK_SECRET: 'bad secret!' }).configured).toBe(false)
    expect(maxConfig(MAX_ENV).configured).toBe(true)
  })
  it('диплинк https://max.ru/<бот>?start=<payload>', () => {
    expect(maxDeeplink('max_x_y', MAX_ENV)).toBe('https://max.ru/test_clinic_bot?start=max_x_y')
  })
  it('сообщение: текст ≤ 4000, кнопки — inline_keyboard с callback', () => {
    const m = buildMaxMessage('a'.repeat(5000), [{ text: 'Подтверждаю', payload: 'ok:t' }])
    expect((m.text as string).length).toBe(4000)
    expect(m.attachments).toEqual([{ type: 'inline_keyboard', payload: { buttons: [[{ type: 'callback', text: 'Подтверждаю', payload: 'ok:t' }]] } }])
  })
  it('POST /messages?user_id=…, токен в заголовке Authorization (не в query)', async () => {
    Object.assign(process.env, MAX_ENV)
    let seen: { url: string; init: RequestInit } | null = null
    const mock = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(JSON.stringify({ message: { body: { mid: 'mid.1', text: 'x' } } }))
    }) as unknown as typeof fetch
    const r = await sendMaxMessage('123456', 'Напоминание', undefined, mock)
    expect(r).toEqual({ ok: true, providerId: 'mid.1', retryable: false, error: null })
    expect(seen!.url).toBe('https://max.mock/messages?user_id=123456')
    expect(seen!.url).not.toContain('token')
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('fake-bot-token')
  })
  it('ошибки: 4xx — постоянная (фолбэк на SMS), 429/5xx — повтор', async () => {
    Object.assign(process.env, MAX_ENV)
    const resp = (status: number) => (async () => new Response(JSON.stringify({ code: 'not.found', message: 'chat not found' }), { status })) as unknown as typeof fetch
    expect((await sendMaxMessage('1', 't', undefined, resp(404))).retryable).toBe(false)
    expect((await sendMaxMessage('1', 't', undefined, resp(429))).retryable).toBe(true)
    expect((await sendMaxMessage('1', 't', undefined, resp(503))).retryable).toBe(true)
    expect((await sendMaxMessage('не-число', 't', undefined, resp(200))).ok).toBe(false)
  })
  it('ответ на callback: POST /answers?callback_id=…', async () => {
    Object.assign(process.env, MAX_ENV)
    let url = ''
    const mock = (async (u: string) => {
      url = u
      return new Response(JSON.stringify({ success: true }))
    }) as unknown as typeof fetch
    expect(await answerMaxCallback('cb-1', 'Запись подтверждена', mock)).toBe(true)
    expect(url).toBe('https://max.mock/answers?callback_id=cb-1')
  })
})
