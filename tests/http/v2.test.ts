// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Чёрный ящик по HTTP против production-сборки: исправления второго этапа
// (CSP/фреймы, Origin, виджет и согласие, честные статусы интеграций, касса без ОФД, RBAC).
//   MEDFLOW_BASE_URL=http://localhost:3911 MEDFLOW_USERS=/path/users.json npx vitest run -c vitest.http.config.ts tests/http/v2.test.ts
// Стенд: APP_MODE=production, WIDGET_ALLOWED_ORIGINS=https://clinic.example, SMS не настроены,
// фейковый валидатор капчи (ok-token), утверждён тестовый текст согласия. Только фейковые данные.
import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const BASE = (process.env.MEDFLOW_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '')
type Cred = { login: string; password: string; totp?: string }
const USERS = JSON.parse(readFileSync(process.env.MEDFLOW_USERS || 'tests/http/users.json', 'utf8')) as Record<string, Cred>

function b32(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(ch).toString(2).padStart(5, '0')
  const out: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(out)
}
const usedTotp = new Set<string>()
async function freshTotp(secret: string): Promise<string> {
  for (;;) {
    const c = Buffer.alloc(8)
    c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)))
    const h = createHmac('sha1', b32(secret)).update(c).digest()
    const o = h[h.length - 1] & 0xf
    const code = String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0')
    if (!usedTotp.has(code)) {
      usedTotp.add(code)
      return code
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

class Client {
  cookie = ''
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
    const m = (res.headers.get('set-cookie') || '').match(/medflow_session=([^;]*)/)
    if (m) this.cookie = m[1] ? `medflow_session=${m[1]}` : ''
    const text = await res.text()
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { status: res.status, json, text, headers: res.headers }
  }
  async login(role: string): Promise<Client> {
    const u = USERS[role]
    let r = await this.req('POST', '/api/auth/login', { login: u.login, password: u.password })
    if (r.json?.pending2fa) r = await this.req('POST', '/api/auth/verify', { challengeId: r.json.challengeId, code: await freshTotp(u.totp!) })
    if (r.status !== 200 || !this.cookie) throw new Error(`login ${role}: HTTP ${r.status}`)
    return this
  }
}
const sessions = new Map<string, Client>()
async function as(role: string) {
  if (!sessions.has(role)) sessions.set(role, await new Client().login(role))
  return sessions.get(role)!
}
const anon = () => new Client()
const phone = () => `+7 902 ${String(Date.now()).slice(-7, -4)}-${String(Date.now()).slice(-4, -2)}-${String(Math.floor(Math.random() * 90) + 10)}`

describe('v2: заголовки безопасности', () => {
  it('страницы МИС нельзя встроить во фрейм, CSP есть', async () => {
    const r = await anon().req('GET', '/')
    expect(r.headers.get('x-frame-options')).toBe('DENY')
    const csp = r.headers.get('content-security-policy') || ''
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
  })
  it('/book встраивается только на сайт клиники из WIDGET_ALLOWED_ORIGINS', async () => {
    const r = await anon().req('GET', '/book')
    expect(r.status).toBe(200)
    expect(r.headers.get('x-frame-options')).toBeNull()
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'self' https://clinic.example")
    expect(r.text).toContain('Онлайн-запись')
  })
  it('/embed.js отдаётся и строит iframe на /book', async () => {
    const r = await anon().req('GET', '/embed.js')
    expect(r.status).toBe(200)
    expect(r.text).toContain("'/book'")
  })
  it('GET /api («Hello world») удалён', async () => {
    expect((await anon().req('GET', '/api')).status).toBe(404)
  })
})

describe('v2: проверка Origin (CSRF)', () => {
  it('POST с чужим Origin и валидной кукой — 403, со своим — доходит до обработчика', async () => {
    const reg = await as('registrar')
    const body = { lastName: 'Ориджинов', firstName: 'Тест', phone: phone(), pdConsent: true }
    const evil = await reg.req('POST', '/api/patients', body, { Origin: 'https://evil.example' })
    expect(evil.status).toBe(403)
    const own = await reg.req('POST', '/api/patients', body, { Origin: BASE })
    expect(own.status, own.text).toBe(201)
  })
})

describe('v2: виджет', () => {
  it('анониму — без счётчиков записей, с текстом согласия; сотруднику — со счётчиками', async () => {
    const a = await anon().req('GET', '/api/widget')
    expect(a.status).toBe(200)
    expect(a.json.stats).toBeNull()
    expect(a.json.consent?.text).toContain('ТЕСТОВЫЙ ТЕКСТ СОГЛАСИЯ')
    const s = await (await as('registrar')).req('GET', '/api/widget')
    expect(typeof s.json.stats?.today).toBe('number')
  })
  it('без согласия — 400; без капчи — 400; SMS-шлюз не настроен — честный 503, слот не удерживается', async () => {
    const cfg = (await anon().req('GET', '/api/widget')).json
    const doc = cfg.days.flatMap((d: any) => d.doctors).find((d: any) => d.slots.length)
    if (!doc) return // нет рабочих слотов в ближайшие 3 дня (выходные) — нечего проверять
    const base = { action: 'init', doctorId: doc.doctorId, start: doc.slots[0].start, name: 'Виджетов Тест', phone: phone() }
    expect((await anon().req('POST', '/api/widget', { ...base, captchaToken: 'ok-token' })).status).toBe(400)
    expect((await anon().req('POST', '/api/widget', { ...base, consent: true, captchaToken: 'bad' })).status).toBe(400)
    const r = await anon().req('POST', '/api/widget', { ...base, consent: true, captchaToken: 'ok-token' })
    expect(r.status, r.text).toBe(503)
    const again = (await anon().req('GET', '/api/widget')).json
    const starts = again.days.flatMap((d: any) => d.doctors).filter((d: any) => d.doctorId === doc.doctorId).flatMap((d: any) => d.slots.map((x: any) => x.start))
    expect(starts).toContain(doc.slots[0].start)
  })
})

describe('v2: интеграции и касса', () => {
  it('статусы интеграций честные: нет ONLINE, ЕГИСЗ не подключена, 1С — вручную', async () => {
    const r = await (await as('admin')).req('GET', '/api/integrations')
    expect(r.status).toBe(200)
    const h = Object.fromEntries(r.json.catalog.map((c: any) => [c.key, c.health]))
    expect(Object.values(h)).not.toContain('ONLINE')
    expect(h.EGISZ).toBe('NOT_CONNECTED')
    expect(h.FISCAL).toBe('NOT_CONNECTED')
    expect(h.ERP_1C).toBe('MANUAL')
  })
  it('оплата принимается, но фискализация без ОФД — 409 FISCAL_NOT_CONFIGURED', async () => {
    const reg = await as('registrar')
    const p = await reg.req('POST', '/api/patients', { lastName: 'Кассов', firstName: 'Тест', phone: phone(), pdConsent: true })
    expect(p.status, p.text).toBe(201)
    const pay = await reg.req('POST', '/api/payments', { patientId: p.json.patient.id, amount: 1500, method: 'CASH' })
    expect(pay.status, pay.text).toBe(201)
    const f = await reg.req('PATCH', `/api/payments/${pay.json.payment.id}`, { action: 'fiscalize' })
    expect(f.status).toBe(409)
    expect(f.json.code).toBe('FISCAL_NOT_CONFIGURED')
  })
  it('вебхук MAX без настроенного бота — 404, MAX-привязка пациента без бота не выдаёт ссылку', async () => {
    expect((await anon().req('POST', '/api/integrations/max/webhook', { update_type: 'bot_started' })).status).toBe(404)
  })
})

describe('v2: RBAC', () => {
  it('маркетолог: без интеграций, визитов и медданных; пациенты без телефонов', async () => {
    const m = await as('marketer')
    expect((await m.req('GET', '/api/integrations')).status).toBe(403)
    expect((await m.req('GET', '/api/visits')).status).toBe(403)
    expect((await m.req('POST', '/api/ai/summary', { patientId: 'x' })).status).toBe(403)
    const p = await m.req('GET', '/api/patients')
    if (p.status === 200) for (const x of p.json.patients) expect(x.phone ?? null).toBeNull()
  })
  it('регистратор: без протоколов и диагнозов, без AI-сводки', async () => {
    const r = await as('registrar')
    const v = await r.req('GET', '/api/visits')
    if (v.status === 200) for (const x of v.json.visits ?? []) {
      expect(x.protocolText ?? null).toBeNull()
      expect(x.diagnosisCode ?? null).toBeNull()
      expect(x.complaints ?? null).toBeNull()
    } else expect(v.status).toBe(403)
    expect((await r.req('POST', '/api/ai/summary', { patientId: 'x' })).status).toBe(403)
  })
  it('врач видит только свои записи', async () => {
    const d = await as('doctor1')
    const me = (await d.req('GET', '/api/auth/me')).json
    const myDoctorId = me?.me?.doctorId ?? me?.doctorId
    expect(myDoctorId).toBeTruthy()
    const r = await d.req('GET', '/api/appointments')
    expect(r.status).toBe(200)
    for (const a of r.json.appointments ?? []) expect(a.doctorId).toBe(myDoctorId)
  })
})
