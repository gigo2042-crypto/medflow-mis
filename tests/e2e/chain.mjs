#!/usr/bin/env node
// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Сквозная проверка по HTTP: вход → пациент → запись → перенос → приём → оплата.
//   MEDFLOW_BASE_URL=http://localhost:3000 E2E_LOGIN=reg1 E2E_PASSWORD=… [E2E_TOTP_SECRET=…] \
//   E2E_DOCTOR_LOGIN=doc1 E2E_DOCTOR_PASSWORD=… [E2E_DOCTOR_TOTP_SECRET=…] node tests/e2e/chain.mjs
// Роли разделены: регистратор (или админ) — пациент, запись, оплата; врач — приём (visits.write есть только у врача).
// Без E2E_DOCTOR_LOGIN всё идёт одной сессией (если права выданы через RBAC_OVERRIDES).
// В демо код 2FA берётся из ответа сервера (только APP_MODE=demo). Секреты в вывод не попадают.
import { createHmac } from 'node:crypto'

const BASE = (process.env.MEDFLOW_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '')
const TZ_OFFSET = process.env.E2E_TZ_OFFSET || '+03:00' // смещение CLINIC_TZ (Europe/Moscow)
let cookie = ''
const jar = {}
let failed = 0

function b32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(ch).toString(2).padStart(5, '0')
  const out = []
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(out)
}
function totp(secret) {
  const c = Buffer.alloc(8)
  c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)))
  const h = createHmac('sha1', b32(secret)).update(c).digest()
  const o = h[h.length - 1] & 0xf
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  })
  const set = res.headers.get('set-cookie')
  if (set) {
    const m = set.match(/medflow_session=([^;]*)/)
    if (m) cookie = m[1] ? `medflow_session=${m[1]}` : ''
  }
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}
function step(name, ok, info = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`)
  if (!ok) failed++
  return ok
}
function ymd(d) { return d.toISOString().slice(0, 10) }

const cfg = await api('GET', '/api/config')
step('config', cfg.status === 200, `mode=${cfg.json?.mode}`)

async function login(tag, loginName, password, totpSecret) {
  cookie = ''
  let r = await api('POST', '/api/auth/login', { login: loginName, password })
  if (r.json?.pending2fa) {
    const code = r.json.method === 'TOTP' ? totp(totpSecret || '') : r.json.demoCode
    step(`${tag}: требуется 2FA`, true, `method=${r.json.method}`)
    r = await api('POST', '/api/auth/verify', { challengeId: r.json.challengeId, code })
  }
  if (!step(`${tag}: вход`, r.status === 200 && cookie, `HTTP ${r.status}`)) process.exit(1)
  const me = (await api('GET', '/api/auth/me')).json?.me
  step(`${tag}: me`, Boolean(me?.role), `role=${me?.role}`)
  jar[tag] = cookie
  return me
}
function as(tag) { cookie = jar[tag] }

const SPLIT = Boolean(process.env.E2E_DOCTOR_LOGIN)
let docMe = null
if (SPLIT) docMe = await login('врач', process.env.E2E_DOCTOR_LOGIN, process.env.E2E_DOCTOR_PASSWORD, process.env.E2E_DOCTOR_TOTP_SECRET)
await login('front', process.env.E2E_LOGIN, process.env.E2E_PASSWORD, process.env.E2E_TOTP_SECRET)
if (!SPLIT) jar['врач'] = jar.front

const doctors = (await api('GET', '/api/doctors')).json?.doctors || []
if (!step('врачи', doctors.length > 0, `${doctors.length}`)) process.exit(1)
const doctor = (docMe?.doctorId && doctors.find((d) => d.id === docMe.doctorId)) || doctors[0]
let services = (await api('GET', '/api/services')).json?.services || []
if (!services.length) {
  const s = await api('POST', '/api/services', { name: 'Первичный приём (E2E)', category: 'Приём', price: 2500 })
  step('услуга в прайсе', s.status === 201)
  services = [s.json?.service]
}
const service = services[0]

const suffix = String(Date.now()).slice(-7)
const p = await api('POST', '/api/patients', { lastName: 'Сквозной', firstName: 'Тест', phone: `+7 900 ${suffix.slice(0, 3)}-${suffix.slice(3, 5)}-${suffix.slice(5)}`, birthDate: '1990-05-15', gender: 'M', pdConsent: true })
if (!step('пациент создан', p.status === 201, p.json?.patient?.cardNumber || p.json?.error)) process.exit(1)
const patientId = p.json.patient.id

// Ищем свободный слот: ближайшие 10 дней, рабочие часы врача
const [wh] = String(doctor.workStart || '09:00').split(':').map(Number)
let appt = null
for (let day = 1; day <= 10 && !appt; day++) {
  const d = new Date(Date.now() + day * 86400000)
  for (let h = wh + 1; h <= wh + 6 && !appt; h++) {
    const start = `${ymd(d)}T${String(h).padStart(2, '0')}:00:00${TZ_OFFSET}`
    const a = await api('POST', '/api/appointments', { patientId, doctorId: doctor.id, start, source: 'REGISTRAR' })
    if (a.status === 201) appt = a.json.appointment
  }
}
if (!step('запись создана', Boolean(appt), appt ? new Date(appt.start).toISOString() : '')) process.exit(1)

// Перенос: на первый свободный слот позже (занятый слот сервер отклоняет с 409)
let rs = null
let newStart = ''
for (const min of [60, 90, 120, 150, 180, 240, 1440, 1500, 1560]) {
  newStart = new Date(new Date(appt.start).getTime() + min * 60000).toISOString()
  rs = await api('PATCH', `/api/appointments/${appt.id}`, { action: 'RESCHEDULE', start: newStart })
  if (rs.status !== 409) break
}
step('перенос записи', rs.status === 200 && new Date(rs.json?.appointment?.start).toISOString() === newStart, `HTTP ${rs.status} ${rs.json?.error || ''} → ${newStart}`)

as('врач')
const v = await api('POST', '/api/visits', { appointmentId: appt.id })
if (!step('приём начат', v.status === 201, `HTTP ${v.status} ${v.json?.error || ''}`)) process.exit(1)
const visitId = v.json.visit.id

const done = await api('PATCH', `/api/visits/${visitId}`, {
  complaints: 'Боль при накусывании', diagnosisCode: 'K02.1', serviceId: service.id,
  protocolText: 'Жалобы: боль. Объективно: кариес. План: лечение.', complete: true,
})
step('приём завершён', done.status === 200, `HTTP ${done.status} ${done.json?.error || ''}`)
const locked = await api('PATCH', `/api/visits/${visitId}`, { complaints: 'правка задним числом' })
step('завершённый приём не редактируется', locked.status === 409, `HTTP ${locked.status}`)

as('front')
const pay = await api('POST', '/api/payments', { patientId, visitId, method: 'CARD' })
step('оплата', pay.status === 201 && pay.json?.payment?.amount === service.price, `HTTP ${pay.status} сумма=${pay.json?.payment?.amount} статус=${pay.json?.payment?.status}`)

for (const tag of Object.keys(jar)) {
  as(tag)
  const out = await api('POST', '/api/auth/logout')
  step(`${tag}: выход`, out.status === 200)
}
console.log(failed ? `\nИТОГ: ошибок ${failed}` : '\nИТОГ: цепочка пройдена')
process.exit(failed ? 1 : 0)
