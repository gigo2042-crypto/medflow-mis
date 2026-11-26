// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Чек-лист Тони, P0/P1 — вход и лимиты (только фейковые данные, одноразовая БД):
//  • 2FA: 50 параллельных неверных кодов на один challenge → код проверен не больше 5 раз;
//  • атомарный rate-limit (hit): из 50 параллельных событий лимит 5 пропускает ровно 5;
//  • виджет: 50 параллельных неверных кодов → не больше 5 сравнений; лимит по IP на confirm;
//  • 2FA обязательна регистратору: вход без TOTP в production → 403;
//  • блокировка входа по «логин+IP»: подбор с одного адреса не блокирует вход с другого; CLI unlock.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { execFileSync } from 'node:child_process'
import { makeDoctor, mockProviders, productionEnv, resetDb, useTestDb } from './helpers'

const totpCalls = { n: 0 }
vi.mock('@/lib/totp', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, verifyTotp: () => { totpCalls.n++; return false } }
})

useTestDb()
let db: Awaited<ReturnType<typeof resetDb>>

function post(path: string, body: unknown, ip = '198.51.100.7') {
  return new NextRequest(`https://mis.example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  db = await resetDb()
  productionEnv({ TRUST_PROXY_HOPS: '1' })
  delete process.env.TWO_FA_ROLES
  totpCalls.n = 0
})

async function staff(login: string, role: string, totp: boolean) {
  const { hashPassword } = await import('@/lib/password')
  return db.staffUser.create({
    data: { login, name: `Тест ${login}`, role, passwordHash: await hashPassword('Fake-pass-12345'), totpEnabled: totp, totpSecret: totp ? 'JBSWY3DPEHPK3PXP' : null },
  })
}

describe('2FA: атомарный счётчик попыток', () => {
  it('50 параллельных неверных кодов на один challenge → не больше 5 проверок кода, challenge сгорает', async () => {
    const u = await staff('reg.totp', 'REGISTRAR', true)
    await db.pendingLogin.create({ data: { id: 'challenge-test-0123456789abcdef0123', userId: u.id, expiresAt: new Date(Date.now() + 300_000) } })
    const { POST } = await import('@/app/api/auth/verify/route')
    // разные IP, чтобы сработал именно лимит challenge, а не лимит адреса
    const res = await Promise.all(Array.from({ length: 50 }, (_, i) => POST(post('/api/auth/verify', { challengeId: 'challenge-test-0123456789abcdef0123', code: String(100000 + i) }, `203.0.113.${i + 1}`))))
    expect(totpCalls.n).toBeLessThanOrEqual(5)
    expect(res.every((r) => r.status === 401 || r.status === 429)).toBe(true)
    expect(res.filter((r) => r.status === 200)).toHaveLength(0)
    expect(await db.pendingLogin.count({ where: { id: 'challenge-test-0123456789abcdef0123' } })).toBe(0)
  })
})

describe('rate-limit.hit — один SQL', () => {
  it('из 50 параллельных событий при лимите 5 разрешено ровно 5, остальные — блокировка', async () => {
    const { hit } = await import('@/lib/rate-limit')
    const r = await Promise.all(Array.from({ length: 50 }, () => hit('test:parallel', 5, 60_000, 60_000)))
    expect(r.filter((x) => x.allowed)).toHaveLength(5)
    const row = await db.rateLimit.findUniqueOrThrow({ where: { key: 'test:parallel' } })
    expect(row.lockedUntil).not.toBeNull()
  })
  it('окно истекло → счёт начинается заново', async () => {
    const { hit } = await import('@/lib/rate-limit')
    await db.rateLimit.create({ data: { key: 'test:old', count: 99, windowStart: new Date(Date.now() - 3600_000) } })
    expect((await hit('test:old', 5, 60_000, 60_000)).allowed).toBe(true)
    expect((await db.rateLimit.findUniqueOrThrow({ where: { key: 'test:old' } })).count).toBe(1)
  })
})

describe('виджет: подтверждение кода', () => {
  async function draft(doctorId: string) {
    return db.widgetDraft.create({
      data: { doctorId, start: new Date(Date.now() + 86400_000), name: 'Фейков Тест', phone: '79000000001', code: '123456', expiresAt: new Date(Date.now() + 600_000) },
    })
  }
  it('50 параллельных неверных кодов → не больше 5 сравнений, черновик истекает, верный код после — отказ', async () => {
    mockProviders()
    const d = await draft((await makeDoctor(db)).id)
    const { POST } = await import('@/app/api/widget/route')
    const res = await Promise.all(Array.from({ length: 50 }, (_, i) => POST(post('/api/widget', { action: 'confirm', draftId: d.id, code: String(200000 + i) }, `203.0.113.${i + 1}`))))
    const bodies = await Promise.all(res.map((r) => r.json()))
    expect(bodies.filter((b) => b.error === 'Неверный код из SMS').length).toBeLessThanOrEqual(4)
    expect(res.filter((r) => r.status === 201)).toHaveLength(0)
    const after = await db.widgetDraft.findUniqueOrThrow({ where: { id: d.id } })
    expect(after.attempts).toBeLessThanOrEqual(5)
    expect(after.status).toBe('EXPIRED')
    const late = await POST(post('/api/widget', { action: 'confirm', draftId: d.id, code: '123456' }, '203.0.113.200'))
    expect(late.status).not.toBe(201)
  })
  it('лимит по IP: больше 30 попыток подтверждения с одного адреса в час → 429', async () => {
    mockProviders()
    const { POST } = await import('@/app/api/widget/route')
    let last = 0
    for (let i = 0; i < 31; i++) last = (await POST(post('/api/widget', { action: 'confirm', draftId: `nope-${i}`, code: '000000' }, '198.51.100.99'))).status
    expect(last).toBe(429)
    expect((await POST(post('/api/widget', { action: 'confirm', draftId: 'nope-x', code: '000000' }, '198.51.100.100'))).status).toBe(400)
  })
})

describe('политика 2FA', () => {
  it('по умолчанию 2FA у всех ролей с ПДн, кроме маркетолога; OIDC_MFA_ROLES = TWO_FA_ROLES', async () => {
    const { twoFaRoles, oidcMfaRoles } = await import('@/lib/auth/twofa-policy')
    expect(twoFaRoles({}).sort()).toEqual(['ADMIN', 'DOCTOR', 'HEAD', 'REGISTRAR'])
    expect(twoFaRoles({})).not.toContain('MARKETER')
    expect(oidcMfaRoles({ TWO_FA_ROLES: 'ADMIN,REGISTRAR,DOCTOR,HEAD,MARKETER' })).toContain('MARKETER')
  })
  it('регистратор без TOTP в production → 403 при входе', async () => {
    await staff('reg.nototp', 'REGISTRAR', false)
    const { POST } = await import('@/app/api/auth/login/route')
    const r = await POST(post('/api/auth/login', { login: 'reg.nototp', password: 'Fake-pass-12345' }))
    expect(r.status).toBe(403)
  })
  it('маркетолог входит без TOTP (обезличенные данные)', async () => {
    await staff('mkt.plain', 'MARKETER', false)
    const { POST } = await import('@/app/api/auth/login/route')
    const r = await POST(post('/api/auth/login', { login: 'mkt.plain', password: 'Fake-pass-12345' }))
    expect(r.status).toBe(200)
  })
  it('SSO: amr=sms или pwd — не MFA; otp/hwk — MFA', async () => {
    const { hasMfa } = await import('@/lib/oidc')
    const base = { iss: 'https://idp.example', sub: 's', aud: 'a', exp: 0, iat: 0 } as never
    expect(hasMfa({ ...(base as object), amr: ['pwd', 'sms'] } as never)).toBe(false)
    expect(hasMfa({ ...(base as object), amr: ['pwd'] } as never)).toBe(false)
    expect(hasMfa({ ...(base as object), amr: ['pwd', 'otp'] } as never)).toBe(true)
  })
  it('env: в production сузить TWO_FA_ROLES/OIDC_MFA_ROLES до ADMIN нельзя', async () => {
    const { validateEnv } = await import('../../scripts/env-rules.mjs')
    const base = { APP_MODE: 'production', DATABASE_URL: 'postgresql://x/y', SESSION_SECRET: 'x'.repeat(40), SERVICE_KEY: 'y'.repeat(30), APP_URL: 'https://mis.example', WIDGET_ENABLED: '0' }
    expect(validateEnv({ ...base, TWO_FA_ROLES: 'ADMIN' }).join('\n')).toMatch(/TWO_FA_ROLES/)
    expect(validateEnv({ ...base, OIDC_MFA_ROLES: 'ADMIN' }).join('\n')).toMatch(/OIDC_MFA_ROLES/)
    expect(validateEnv({ ...base }).join('\n')).not.toMatch(/TWO_FA_ROLES|OIDC_MFA_ROLES/)
  })
})

describe('блокировка входа по логину+IP', () => {
  it('5 неверных паролей с одного IP блокируют этот IP для логина, вход с другого IP работает; CLI unlock снимает', async () => {
    await staff('mkt.lock', 'MARKETER', false)
    const { POST } = await import('@/app/api/auth/login/route')
    for (let i = 0; i < 6; i++) await POST(post('/api/auth/login', { login: 'mkt.lock', password: `wrong-${i}-xxxxxx` }, '192.0.2.10'))
    expect((await POST(post('/api/auth/login', { login: 'mkt.lock', password: 'Fake-pass-12345' }, '192.0.2.10'))).status).toBe(429)
    expect((await POST(post('/api/auth/login', { login: 'mkt.lock', password: 'Fake-pass-12345' }, '192.0.2.11'))).status).toBe(200)
    execFileSync('npx', ['tsx', 'scripts/cli.ts', 'unlock', '--login', 'mkt.lock'], { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, stdio: 'pipe' })
    expect((await POST(post('/api/auth/login', { login: 'mkt.lock', password: 'Fake-pass-12345' }, '192.0.2.10'))).status).toBe(200)
  }, 60_000)
})
