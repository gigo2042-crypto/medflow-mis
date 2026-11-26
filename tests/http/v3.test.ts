// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Чёрный ящик по HTTP: матрица прав «роль × эндпоинт × статус × поля» (чек-лист Тони, P0).
// Гоняется одинаково против APP_MODE=production и APP_MODE=demo — demo не должен обходить RBAC.
//   MEDFLOW_BASE_URL=http://127.0.0.1:3933 MEDFLOW_USERS=users.json npx vitest run -c vitest.http.config.ts tests/http/v3.test.ts
// users.json: admin, registrar, doctor1, doctor2, marketer, head (+ registrar_nototp — учётка без TOTP). Только фейковые данные.
import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

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
function totp(secret: string, t = Date.now()): string {
  const c = Buffer.alloc(8)
  c.writeBigUInt64BE(BigInt(Math.floor(t / 30000)))
  const h = createHmac('sha1', b32(secret)).update(c).digest()
  const o = h[h.length - 1] & 0xf
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}
const used = new Set<string>()
async function freshTotp(secret: string) {
  for (;;) {
    const c = totp(secret)
    if (!used.has(secret + c)) {
      used.add(secret + c)
      return c
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

class Client {
  cookie = ''
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: BASE, ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
    const set = res.headers.get('set-cookie')
    const m = set?.match(/medflow_session=([^;]*)/)
    if (m) this.cookie = `medflow_session=${m[1]}`
    const text = await res.text()
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { status: res.status, json, text }
  }
  async login(role: string) {
    const u = USERS[role]
    let r = await this.req('POST', '/api/auth/login', { login: u.login, password: u.password })
    if (r.json?.pending2fa) r = await this.req('POST', '/api/auth/verify', { challengeId: r.json.challengeId, code: r.json.demoCode ?? (await freshTotp(u.totp!)) })
    if (r.status !== 200 || !this.cookie) throw new Error(`login ${role}: HTTP ${r.status} ${r.text.slice(0, 120)}`)
    return this
  }
}
const S: Record<string, Client> = {}
const ROLES = ['admin', 'registrar', 'doctor1', 'marketer', 'head'] as const
let mode = 'production'
const ctx: Record<string, string> = {}
const today = new Date().toISOString().slice(0, 10)

beforeAll(async () => {
  for (const r of [...ROLES, 'doctor2']) S[r] = await new Client().login(r)
  mode = (await new Client().req('GET', '/api/config')).json?.mode ?? 'production'
  const a = S.admin
  const visits = (await a.req('GET', '/api/visits')).json.visits as Array<{ id: string; patientId: string; doctorId: string; diagnosisCode: string | null }>
  const d1 = (await S.doctor1.req('GET', '/api/auth/me')).json.me.doctorId as string
  const v = visits.find((x) => x.diagnosisCode && x.doctorId === d1) ?? visits.find((x) => x.diagnosisCode)!
  ctx.visitId = v.id
  ctx.patientId = v.patientId
  const all = (await a.req('GET', '/api/patients?all=1&pageSize=100')).json.patients as Array<{ id: string }>
  const own = new Set(((await S.doctor1.req('GET', '/api/patients?all=1&pageSize=100')).json.patients as Array<{ id: string }>).map((p) => p.id))
  ctx.foreignPatientId = all.find((p) => !own.has(p.id))?.id ?? ''
  const tpls = (await a.req('GET', '/api/doc-templates')).json.templates as Array<{ id: string; name: string; body?: string }>
  ctx.consentTpl = tpls.find((t) => /Информированное/.test(t.name))?.id ?? tpls[0].id
}, 120_000)

// Ожидаемые статусы: 200 — доступ есть, 403 — нет (по умолчанию матрицы; RBAC_OVERRIDES на стенде не задан)
type Row = [string, Record<(typeof ROLES)[number], number>]
const A = (admin: number, registrar: number, doctor1: number, marketer: number, head: number) => ({ admin, registrar, doctor1, marketer, head })
const MATRIX: Row[] = [
  [`/api/schedule?date=${today}`, A(200, 200, 200, 403, 403)],
  ['/api/appointments', A(200, 200, 200, 403, 403)],
  ['/api/patients', A(200, 200, 200, 200, 403)],
  ['/api/doctors', A(200, 200, 200, 403, 403)],
  ['/api/services', A(200, 200, 403, 403, 403)],
  ['/api/payments', A(200, 200, 403, 403, 403)],
  ['/api/documents', A(200, 200, 200, 403, 403)],
  ['/api/doc-templates', A(200, 200, 200, 403, 403)],
  ['/api/waiting-list', A(200, 200, 403, 403, 403)],
  ['/api/reminders', A(200, 200, 403, 403, 403)],
  ['/api/reminder-rules', A(200, 200, 403, 403, 403)],
  ['/api/notifications', A(200, 403, 403, 200, 403)],
  ['/api/stock', A(200, 403, 403, 403, 403)],
  ['/api/integrations', A(200, 403, 403, 403, 403)],
  ['/api/integrations/1c', A(200, 403, 403, 403, 403)],
  ['/api/reports', A(200, 403, 403, 200, 200)],
  ['/api/reports/scheduler', A(200, 403, 403, 200, 200)],
  ['/api/dashboard', A(200, 403, 403, 200, 200)],
  ['/api/audit?take=5', A(200, 403, 403, 403, 200)],
  ['/api/sessions', A(200, 403, 403, 403, 403)],
  ['/api/staff', A(200, 403, 403, 403, 403)],
  ['/api/campaigns', A(200, 403, 403, 200, 403)],
  ['/api/no-show-risks', A(200, 200, 200, 403, 403)],
  ['/api/schedule/exceptions', A(200, 200, 200, 403, 403)],
]

describe('матрица прав: роль × эндпоинт → статус', () => {
  for (const [path, exp] of MATRIX) {
    it(`GET ${path}`, async () => {
      const got: Record<string, number> = {}
      for (const r of ROLES) got[r] = (await S[r].req('GET', path)).status
      expect(got).toEqual(exp)
    })
  }
})

describe('меню = права с сервера; demo не расширяет права', () => {
  const TABS: Record<string, string[]> = {
    admin: ['reg', 'schedule', 'waiting', 'reminders', 'notifications', 'emk', 'cash', 'docs', 'stock', 'integrations', 'reports', 'widget', 'dashboard', 'sessions', 'campaigns'],
    registrar: ['reg', 'schedule', 'waiting', 'reminders', 'cash', 'docs'],
    doctor1: ['schedule', 'emk', 'docs'],
    marketer: ['notifications', 'reports', 'dashboard', 'campaigns'],
    head: ['reports', 'dashboard', 'sessions'],
  }
  for (const r of ROLES) {
    it(`${r}: вкладки`, async () => {
      expect((await S[r].req('GET', '/api/auth/me')).json.me.tabs).toEqual(TABS[r])
    })
  }
})

describe('регистратор: прямые вызовы закрытых API → 403', () => {
  const calls: Array<[string, string, unknown]> = [
    ['GET', '/api/integrations', undefined],
    ['POST', '/api/integrations', { action: 'PROCESS' }],
    ['POST', '/api/integrations', { action: 'CALL_IN', phone: '+79000000000' }],
    ['GET', '/api/stock', undefined],
    ['POST', '/api/stock', { action: 'RECEIVE' }],
    ['PATCH', '/api/patients/PID', { phone: '+79000000001' }],
    ['DELETE', '/api/patients/PID', { confirm: 'ОБЕЗЛИЧИТЬ' }],
    ['POST', '/api/patients/PID/max', { action: 'SEND_INVITE' }],
    ['PATCH', '/api/doctors/DID', { name: 'x' }],
    ['POST', '/api/visits', { appointmentId: 'x' }],
    ['GET', '/api/visits', undefined],
  ]
  for (const [m, p, b] of calls) {
    it(`${m} ${p}`, async () => {
      const path = p.replace('PID', ctx.patientId).replace('DID', 'any')
      expect((await S.registrar.req(m, path, b)).status).toBe(403)
    })
  }
})

describe('лишние поля сервер не отдаёт', () => {
  it('регистратор: визиты пациента — без медполей, телефона, даты рождения и заметок врача', async () => {
    const r = await S.registrar.req('GET', `/api/visits?patientId=${ctx.patientId}`)
    expect(r.status).toBe(200)
    for (const v of r.json.visits) {
      for (const k of ['complaints', 'protocolText', 'diagnosisCode', 'diagnosisName', 'templateData']) expect(v[k] ?? null, k).toBeNull()
      for (const k of ['phone', 'birthDate', 'notes']) expect(v.patient?.[k], k).toBeUndefined()
    }
  })
  it('регистратор: в списке пациентов нет заметок врача', async () => {
    const r = await S.registrar.req('GET', '/api/patients?all=1&pageSize=100')
    for (const p of r.json.patients) expect(p.notes ?? null).toBeNull()
  })
  it('регистратор и врач-чужой: рендер документа не раскрывает диагноз и чужого пациента', async () => {
    const reg = await S.registrar.req('POST', '/api/doc-templates/render', { patientId: ctx.patientId, templateId: ctx.consentTpl, visitId: ctx.visitId })
    expect(reg.status).toBe(200)
    const diag = ((await S.admin.req('GET', `/api/visits?patientId=${ctx.patientId}`)).json.visits as Array<{ id: string; diagnosisCode: string }>).find((v) => v.id === ctx.visitId)!.diagnosisCode
    expect(reg.json.content).not.toContain(diag)
    if (ctx.foreignPatientId) {
      const d = await S.doctor1.req('POST', '/api/doc-templates/render', { patientId: ctx.foreignPatientId, templateId: ctx.consentTpl })
      expect(d.status).toBe(403)
    }
  })
  it('руководитель: в отчётах нет ФИО пациентов, в дашборде — тоже', async () => {
    const fin = await S.head.req('GET', '/api/reports?section=finance')
    expect(fin.status).toBe(200)
    const names = ((await S.admin.req('GET', '/api/patients?all=1&pageSize=100')).json.patients as Array<{ lastName: string }>).map((p) => p.lastName).filter((n) => n.length > 3)
    for (const n of names) expect(fin.text.includes(n), n).toBe(false)
    const dash = await S.head.req('GET', '/api/dashboard')
    for (const n of names) expect(dash.text.includes(n), n).toBe(false)
  })
  it('маркетолог: список пациентов обезличен', async () => {
    const r = await S.marketer.req('GET', '/api/patients')
    for (const p of r.json.patients) for (const k of ['lastName', 'phone', 'birthDate', 'cardNumber']) expect(p[k], k).toBeUndefined()
  })
})

describe('поиск вместо реестра', () => {
  it('без запроса — только записанные на ближайшие дни; вся картотека — явным действием с записью в аудит', async () => {
    const up = await S.registrar.req('GET', '/api/patients')
    expect(up.json.scope).toBe('upcoming')
    const all = await S.registrar.req('GET', '/api/patients?all=1')
    expect(all.json.scope).toBe('all')
    expect(all.json.total).toBeGreaterThanOrEqual(up.json.total)
    const audit = (await S.admin.req('GET', '/api/audit?take=50')).json.entries as Array<{ action: string }>
    expect(audit.some((e) => e.action === 'patient.list_all')).toBe(true)
    expect(audit.some((e) => e.action === 'patient.list')).toBe(true)
  })
})

describe('2FA', () => {
  it('регистратор без TOTP: в production вход запрещён (403); в demo — только через одноразовый код', async () => {
    if (!USERS.registrar_nototp) return
    const r = await new Client().req('POST', '/api/auth/login', { login: USERS.registrar_nototp.login, password: USERS.registrar_nototp.password })
    if (mode === 'production') expect(r.status).toBe(403)
    else expect(r.json?.pending2fa).toBe(true)
  })
})

describe('мониторинг: /api/metrics', () => {
  const token = process.env.MEDFLOW_METRICS_TOKEN
  it('без токена 401, с неверным 401, с верным — Prometheus без ПДн; /api/health открыт', async () => {
    expect((await fetch(`${BASE}/api/health`)).status).toBe(200)
    if (!token) {
      // METRICS_TOKEN не задан на стенде — эндпоинт выключен
      expect((await fetch(`${BASE}/api/metrics`)).status).toBe(404)
      return
    }
    expect((await fetch(`${BASE}/api/metrics`)).status).toBe(401)
    expect((await fetch(`${BASE}/api/metrics`, { headers: { authorization: 'Bearer wrong-token-wrong-token-wrong' } })).status).toBe(401)
    const r = await fetch(`${BASE}/api/metrics`, { headers: { authorization: `Bearer ${token}` } })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/plain; version=0.0.4')
    const t = await r.text()
    expect(t).toMatch(/^medflow_up 1$/m)
    expect(t).toMatch(/^medflow_db_up 1$/m)
    expect(t).toMatch(/^# TYPE medflow_fiscal_payments gauge$/m)
    expect(t).toMatch(/^medflow_sessions_active \d+$/m)
    // только имена метрик, метки и числа
    for (const line of t.trim().split('\n')) expect(line).toMatch(/^(# (HELP|TYPE) medflow_\w+ .+|medflow_\w+(\{[a-z_]+="[\w.-]*"(,[a-z_]+="[\w.-]*")*\})? -?[\d.e+-]+)$/)
  })
})

describe('P2: CSP с nonce, мёртвый вебхук почты', () => {
  it('страница: CSP без unsafe-inline для скриптов, у всех <script> nonce из заголовка, nonce новый на запрос', async () => {
    const r1 = await fetch(`${BASE}/`)
    const csp = r1.headers.get('content-security-policy') || ''
    const script = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src')) || ''
    const nonce = /'nonce-([^']+)'/.exec(script)?.[1]
    expect(nonce).toBeTruthy()
    expect(script).not.toContain('unsafe-inline')
    expect(script).not.toContain('unsafe-eval')
    expect(csp).toContain("frame-ancestors 'none'")
    const html = await r1.text()
    const tags = html.match(/<script\b[^>]*>/g) || []
    expect(tags.length).toBeGreaterThan(0)
    for (const t of tags) expect(t, t).toContain(`nonce="${nonce}"`)
    const nonce2 = /'nonce-([^']+)'/.exec((await fetch(`${BASE}/`)).headers.get('content-security-policy') || '')?.[1]
    expect(nonce2).not.toBe(nonce)
  })
  it('/book: CSP с nonce и frame-ancestors сайтов клиники; API — default-src none', async () => {
    const b = await fetch(`${BASE}/book`)
    expect(b.headers.get('content-security-policy')).toMatch(/'nonce-[^']+'.*frame-ancestors 'self' https:\/\/clinic\.example/)
    expect((await fetch(`${BASE}/api/health`)).headers.get('content-security-policy')).toContain("default-src 'none'")
  })
  it('/api/integrations/email/webhook: production — 404 (вырезан), demo — только по ключу сервиса', async () => {
    const r = await fetch(`${BASE}/api/integrations/email/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(mode === 'production' ? 404 : 401)
  })
})
