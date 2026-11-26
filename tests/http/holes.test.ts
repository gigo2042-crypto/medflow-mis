// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Чёрный ящик по HTTP: каждая проверка — дыра из чек-листа ревью.
// Запускается и против старого кода (дыры должны «краснеть»), и против нового (зелёные).
//   MEDFLOW_BASE_URL=http://localhost:3000 MEDFLOW_USERS=/path/users.json MEDFLOW_TARGET=new npm run test:http
// users.json: { admin:{login,password,totp?}, doctor1, doctor2, marketer, registrar } — только тестовые учётки.
import { readFileSync } from 'node:fs'
import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const BASE = (process.env.MEDFLOW_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '')
const TARGET = process.env.MEDFLOW_TARGET || 'new'
type Cred = { login: string; password: string; totp?: string }
const USERS = JSON.parse(readFileSync(process.env.MEDFLOW_USERS || 'tests/http/users.json', 'utf8')) as Record<string, Cred>
const TZ_OFFSET = process.env.E2E_TZ_OFFSET || '+03:00'

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
const usedTotp = new Set<string>()
async function freshTotp(secret: string): Promise<string> {
  for (;;) {
    const c = totp(secret)
    if (!usedTotp.has(c)) {
      usedTotp.add(c)
      return c
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
    if (r.json?.pending2fa) {
      const code = u.totp ? await freshTotp(u.totp) : r.json.demoCode
      r = await this.req('POST', '/api/auth/verify', { challengeId: r.json.challengeId, code })
    }
    if (r.status !== 200 || !this.cookie) throw new Error(`login ${role}: HTTP ${r.status} ${r.json?.error ?? ''}`)
    return this
  }
}
const as = (role: string) => new Client().login(role)
const rnd = () => randomBytes(3).toString('hex')

async function newPatient(c: Client, lastName = 'Проверкин') {
  const n = String(Date.now() + Math.floor(Math.random() * 1000)).slice(-7)
  const r = await c.req('POST', '/api/patients', { lastName, firstName: 'Тест', phone: `+7 901 ${n.slice(0, 3)}-${n.slice(3, 5)}-${n.slice(5)}`, birthDate: '1985-03-03', gender: 'F', pdConsent: true })
  expect(r.status, r.text).toBe(201)
  return r.json.patient
}
async function book(c: Client, patientId: string, doctorId: string, dayFrom = 2) {
  for (let day = dayFrom; day < dayFrom + 20; day++) {
    const d = new Date(Date.now() + day * 86400000).toISOString().slice(0, 10)
    for (const hm of ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '14:00', '15:00', '16:00']) {
      const r = await c.req('POST', '/api/appointments', { patientId, doctorId, start: `${d}T${hm}:00${TZ_OFFSET}`, source: 'REGISTRAR' })
      if (r.status === 201) return r.json.appointment
    }
  }
  throw new Error('нет свободного слота')
}
async function doctorIdOf(role: string, fallbackIndex: number): Promise<string> {
  const c = await as(role)
  const me = await c.req('GET', '/api/auth/me')
  const id = me.json?.me?.doctorId ?? me.json?.doctorId
  if (id) return id
  const ds = (await c.req('GET', '/api/doctors')).json?.doctors ?? []
  return ds[fallbackIndex].id
}

describe(`MedFlow HTTP (${TARGET}) — дыры из чек-листа`, () => {
  it('[1] 1C-пакет недоступен без входа', async () => {
    const adm = await as('admin')
    const id = (await adm.req('GET', '/api/integrations/1c')).json?.exports?.[0]?.id ?? 'any-id'
    const r = await new Client().req('GET', `/api/integrations/1c/${id}`)
    expect(r.status).toBe(401)
  })

  it('[2] ответ на вход не содержит код 2FA, challengeId случайный', async () => {
    const r = await new Client().req('POST', '/api/auth/login', { login: USERS.admin.login, password: USERS.admin.password })
    expect(r.status).toBe(200)
    expect(r.json?.pending2fa).toBe(true)
    expect(r.json).not.toHaveProperty('demoCode')
    expect(String(r.json?.challengeId).length).toBeGreaterThanOrEqual(32)
  })

  it('[2] после 5 неверных кодов challenge сгорает (даже верный код не принимается)', async () => {
    const c = new Client()
    const r = await c.req('POST', '/api/auth/login', { login: USERS.admin.login, password: USERS.admin.password })
    const right = USERS.admin.totp ? totp(USERS.admin.totp) : r.json.demoCode
    const wrong = right === '000000' ? '111111' : '000000'
    for (let i = 0; i < 5; i++) await c.req('POST', '/api/auth/verify', { challengeId: r.json.challengeId, code: wrong })
    const last = await c.req('POST', '/api/auth/verify', { challengeId: r.json.challengeId, code: right })
    expect(last.status).not.toBe(200)
  })

  it.runIf(Boolean(USERS.admin.totp))('[2] TOTP-код нельзя использовать повторно', async () => {
    const code = await freshTotp(USERS.admin.totp!)
    const a = new Client()
    const r1 = await a.req('POST', '/api/auth/login', { login: USERS.admin.login, password: USERS.admin.password })
    expect((await a.req('POST', '/api/auth/verify', { challengeId: r1.json.challengeId, code })).status).toBe(200)
    const b = new Client()
    const r2 = await b.req('POST', '/api/auth/login', { login: USERS.admin.login, password: USERS.admin.password })
    expect((await b.req('POST', '/api/auth/verify', { challengeId: r2.json.challengeId, code })).status).toBe(401)
  })

  it('[3] служебный вызов с демо-ключом по умолчанию отклоняется', async () => {
    const r = await new Client().req('POST', '/api/notifications', { action: 'PROCESS' }, { 'X-Service-Key': 'medflow-service-key' })
    expect([401, 403]).toContain(r.status)
  })

  it('[6] маркетолог не видит телефоны и даты рождения пациентов', async () => {
    const c = await as('marketer')
    const r = await c.req('GET', '/api/patients')
    if (r.status === 403) return // полностью закрыто — тоже допустимо
    expect(r.status).toBe(200)
    const list = r.json?.patients ?? []
    expect(list.length).toBeGreaterThan(0)
    for (const p of list) {
      expect(p.phone ?? null).toBeNull()
      expect(p.birthDate ?? null).toBeNull()
    }
  })

  it('[6] врач не может править приём другого врача', async () => {
    const reg = await as('registrar')
    const d2 = await doctorIdOf('doctor2', 1)
    const p = await newPatient(reg)
    const a = await book(reg, p.id, d2)
    const doc2 = await as('doctor2')
    const v = await doc2.req('POST', '/api/visits', { appointmentId: a.id })
    expect(v.status, v.text).toBe(201)
    const doc1 = await as('doctor1')
    const edit = await doc1.req('PATCH', `/api/visits/${v.json.visit.id}`, { complaints: 'чужая правка' })
    expect(edit.status).toBe(403)
  })

  it('[6] отчёты по расписанию нельзя отправить на внешний адрес', async () => {
    const c = await as('admin')
    const r = await c.req('POST', '/api/reports/scheduler', { action: 'CREATE', name: `Утечка ${rnd()}`, reportKey: 'CASH_DAY', period: 'DAILY', atTime: '09:00', recipients: 'leak@gmail.com' })
    expect([400, 403]).toContain(r.status)
  })

  it('[7] выход завершает только текущую сессию', async () => {
    const a = await as('registrar')
    const b = await as('registrar')
    await a.req('POST', '/api/auth/logout')
    expect((await a.req('GET', '/api/auth/me')).status).toBe(401)
    expect((await b.req('GET', '/api/auth/me')).status).toBe(200)
  })

  it('[7] перебор пароля блокируется', async () => {
    const c = new Client()
    const login = `ghost-${rnd()}`
    let last = 0
    for (let i = 0; i < 7; i++) last = (await c.req('POST', '/api/auth/login', { login, password: `wrong-${i}` })).status
    expect(last).toBe(429)
  })

  it('[9] запись можно перенести (RESCHEDULE)', async () => {
    const reg = await as('registrar')
    const d1 = await doctorIdOf('doctor1', 0)
    const p = await newPatient(reg)
    const a = await book(reg, p.id, d1, 25)
    let r: Awaited<ReturnType<Client['req']>> | null = null
    let to = ''
    for (const hours of [1, 1.5, 2, 3, 4, 24, 25, 26]) {
      to = new Date(new Date(a.start).getTime() + hours * 3600_000).toISOString()
      r = await reg.req('PATCH', `/api/appointments/${a.id}`, { action: 'RESCHEDULE', start: to })
      if (r.status !== 409) break
    }
    expect(r!.status, r!.text).toBe(200)
    expect(new Date(r!.json.appointment.start).toISOString()).toBe(to)
  })

  it('[12] платёж в списке кассы отдаёт статус', async () => {
    const c = await as('admin')
    // касса по умолчанию — за сегодня; утром оплат может ещё не быть, поэтому смотрим до 7 дней назад
    let r = await c.req('GET', '/api/payments')
    for (let d = 1; d <= 7 && r.status === 200 && !(r.json?.payments ?? []).length; d++) {
      r = await c.req('GET', `/api/payments?date=${new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10)}`)
    }
    expect(r.status).toBe(200)
    const list = r.json?.payments ?? []
    expect(list.length).toBeGreaterThan(0)
    for (const p of list) expect(typeof p.status).toBe('string')
  })

  it('[13] список пациентов постраничный', async () => {
    const reg = await as('registrar')
    await newPatient(reg)
    await newPatient(reg)
    const r = await reg.req('GET', '/api/patients?all=1&page=1&pageSize=1') // вся картотека — явным действием (all=1)
    expect(r.status).toBe(200)
    expect(r.json.patients.length).toBe(1)
    expect(r.json.total).toBeGreaterThan(1)
  })

  it('[15] в журнале аудита нет ФИО пациента', async () => {
    const reg = await as('registrar')
    const lastName = `Аудитов${rnd().replace(/\d/g, 'ж')}`
    await newPatient(reg, lastName)
    const adm = await as('admin')
    const r = await adm.req('GET', '/api/audit?take=100')
    expect(r.status).toBe(200)
    expect(r.text).not.toContain(lastName)
  })

  it('[5] старый вход SSO с клиентским state удалён', async () => {
    const r = await new Client().req('POST', '/api/auth/sso', { code: 'x', state: 'x', redirect_uri: 'https://evil.example/cb' })
    expect([404, 405]).toContain(r.status)
  })

  it.runIf(TARGET === 'new')('[prod] демо-маршруты отдают 404', async () => {
    for (const p of ['/api/demo/accounts', '/api/demo/reset']) {
      expect((await new Client().req('GET', p)).status).toBe(404)
      expect((await new Client().req('POST', p, {})).status).toBe(404)
    }
  })
})
