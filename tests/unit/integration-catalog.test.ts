// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: {} }))
import { integrationCatalog } from '@/lib/integrations'

const KEYS = ['APP_MODE', 'FISCAL_PROVIDER', 'SMS_PROVIDER', 'EMAIL_PROVIDER', 'MAX_BOT_TOKEN', 'MAX_BOT_NAME', 'MAX_WEBHOOK_SECRET', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET']
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })
function setEnv(e: Record<string, string>) { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, e) }
const byKey = () => Object.fromEntries(integrationCatalog().map((c) => [c.key, c.health]))

describe('статусы интеграций (#16)', () => {
  it('production без настроек: ничего не «online», шлюзы без коннекторов — не подключены, 1С — вручную', () => {
    setEnv({ APP_MODE: 'production' })
    const h = byKey()
    for (const k of ['EGISZ', 'LAB', 'DMS', 'TELEPHONY', 'FISCAL', 'SMS', 'MAX', 'EMAIL', 'SSO']) expect(h[k], k).toBe('NOT_CONNECTED')
    expect(h.ERP_1C).toBe('MANUAL')
    expect(Object.values(h)).not.toContain('ONLINE')
  })
  it('production с фейковыми реквизитами: настроено только то, что настроено; ЕГИСЗ/лаборатории по-прежнему не подключены', () => {
    setEnv({ APP_MODE: 'production', SMS_PROVIDER: 'smsru', EMAIL_PROVIDER: 'smtp', MAX_BOT_TOKEN: 'fake', MAX_BOT_NAME: 'fake_bot', MAX_WEBHOOK_SECRET: 'fake_secret_123', OIDC_ISSUER: 'https://idp.example.test', OIDC_CLIENT_ID: 'x', OIDC_CLIENT_SECRET: 'y' })
    const h = byKey()
    expect([h.SMS, h.EMAIL, h.MAX, h.SSO]).toEqual(['CONFIGURED', 'CONFIGURED', 'CONFIGURED', 'CONFIGURED'])
    expect([h.EGISZ, h.LAB, h.DMS, h.TELEPHONY]).toEqual(['NOT_CONNECTED', 'NOT_CONNECTED', 'NOT_CONNECTED', 'NOT_CONNECTED'])
    expect(h.FISCAL).toBe('NOT_CONNECTED')
  })
  it('демо: всё помечено как симулятор', () => {
    setEnv({ APP_MODE: 'demo' })
    const h = byKey()
    for (const k of ['EGISZ', 'LAB', 'DMS', 'TELEPHONY', 'FISCAL', 'SMS', 'MAX', 'EMAIL', 'ERP_1C', 'SSO']) expect(h[k], k).toBe('SIMULATOR')
  })
})
