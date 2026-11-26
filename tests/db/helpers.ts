// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Общие помощники интеграционных тестов: только фейковые данные, одноразовая БД.
import { vi } from 'vitest'

export function useTestDb() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL не задан (одноразовая БД с применёнными миграциями)')
  if (!/test/i.test(url)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую БД (в имени — test)')
  process.env.DATABASE_URL = url
  process.env.SESSION_SECRET ||= 'test-session-secret-0123456789-abcdefgh'
  process.env.APP_URL ||= 'https://mis.example.test'
}

export async function resetDb() {
  const { db } = await import('@/lib/db')
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  // AuditLog неизменяем (триггер): очистка тестовой БД — в одной транзакции с флагом обслуживания
  await db.$transaction([
    db.$executeRawUnsafe(`SELECT set_config('medflow.audit_maintenance', 'on', true)`),
    db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`),
  ])
  return db
}

/** Мок fetch: SMS.ru и MAX отвечают успехом, все вызовы записываются. */
export function mockProviders() {
  const calls: Array<{ url: string; body: string }> = []
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '')
    calls.push({ url: u, body })
    // имитация задержки сети: окно гонки между параллельными воркерами
    await new Promise((r) => setTimeout(r, 30))
    if (u.includes('sms.mock')) {
      const to = new URLSearchParams(body).get('to') || ''
      return new Response(JSON.stringify({ status: 'OK', sms: { [to]: { status: 'OK', sms_id: `sms-${calls.length}` } } }))
    }
    if (u.includes('max.mock')) {
      if (u.includes('user_id=404')) return new Response(JSON.stringify({ code: 'chat.not.found', message: 'fake' }), { status: 404 })
      return new Response(JSON.stringify({ message: { body: { mid: `mid-${calls.length}` } } }))
    }
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

export function productionEnv(extra: Record<string, string> = {}) {
  Object.assign(process.env, {
    APP_MODE: 'production',
    SMS_PROVIDER: 'smsru',
    SMSRU_API_ID: 'fake-api-id',
    SMSRU_URL: 'https://sms.mock/sms/send',
    ...extra,
  })
}

let seq = 0
export async function makePatient(db: Awaited<ReturnType<typeof resetDb>>, data: Record<string, unknown> = {}) {
  seq++
  return db.patient.create({
    data: { cardNumber: `T-${seq}-${Date.now()}`, lastName: 'Тестов', firstName: `Пациент${seq}`, phone: `+7 900 000-00-${String(seq).padStart(2, '0')}`, ...data },
  })
}

export async function makeDoctor(db: Awaited<ReturnType<typeof resetDb>>, data: Record<string, unknown> = {}) {
  return db.doctor.create({ data: { name: 'Врач Тестовый', specialty: 'Терапевт', workStart: '09:00', workEnd: '18:00', slotMinutes: 30, ...data } })
}

type Db = Awaited<ReturnType<typeof resetDb>>

/** Сотрудник с живой сессией: возвращает пользователя и cookie для NextRequest. */
export async function staffSession(db: Db, role: string, data: Record<string, unknown> = {}) {
  const { hashToken, SESSION_COOKIE } = await import('@/lib/auth-server')
  const { randomBytes } = await import('node:crypto')
  seq++
  const user = await db.staffUser.create({ data: { login: `t.${role.toLowerCase()}.${seq}`, name: `Тест ${role}`, role, totpEnabled: true, ...data } })
  const token = randomBytes(24).toString('base64url')
  await db.authSession.create({ data: { id: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + 3600_000) } })
  return { user, cookie: `${SESSION_COOKIE}=${token}` }
}

/** NextRequest с cookie сессии. */
export async function authed(cookie: string, method: string, path: string, body?: unknown) {
  const { NextRequest } = await import('next/server')
  return new NextRequest(`https://mis.example.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': '198.51.100.20' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** Приём и визит у врача (фейковые данные). */
export async function makeVisit(db: Db, patientId: string, doctorId: string, data: Record<string, unknown> = {}) {
  const appt = await db.appointment.create({
    data: { patientId, doctorId, start: new Date(Date.now() - 3600_000), duration: 30, status: 'ARRIVED', source: 'REGISTRAR' },
  })
  return db.visit.create({ data: { appointmentId: appt.id, patientId, doctorId, ...data } })
}
