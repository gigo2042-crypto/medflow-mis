// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Регрессия #17 и 4.4/4.7: публичная запись через виджет — согласие на ПДн обязательно и сохраняется,
// пациент ищется по телефону (8…/+7…) И фамилии без загрузки картотеки, GET без побочных эффектов
// и без публичных счётчиков, приглашение в MAX после записи. Только фейковые данные.
import { beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { makeDoctor, mockProviders, productionEnv, resetDb, useTestDb } from './helpers'

useTestDb()
let db: Awaited<ReturnType<typeof resetDb>>
let ipSeq = 0

const CONSENT_TEXT = 'Фейковый текст согласия на обработку ПДн для тестов.'

function req(method: 'GET' | 'POST', body?: unknown) {
  ipSeq++
  return new NextRequest('https://mis.example.test/api/widget', {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${ipSeq % 250}` },
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function route() {
  return import('@/app/api/widget/route')
}

async function slotTomorrow(hour = 10) {
  const { addDaysKey, todayKey, zonedTime, parseDateKey } = await import('@/lib/mis-utils')
  const k = parseDateKey(addDaysKey(todayKey(), 1))!
  return zonedTime(k.y, k.m, k.d, hour, 0)
}

async function book(doctorId: string, start: Date, name: string, phone: string, extra: Record<string, unknown> = {}) {
  const { POST } = await route()
  const init = await POST(req('POST', { action: 'init', doctorId, start: start.toISOString(), name, phone, consent: true, ...extra }))
  const ij = await init.json()
  if (init.status !== 200) return { status: init.status, json: ij }
  const draft = await db.widgetDraft.findUniqueOrThrow({ where: { id: ij.draftId } })
  expect(ij.code).toBeUndefined() // в production код только по SMS
  const conf = await POST(req('POST', { action: 'confirm', draftId: draft.id, code: draft.code }))
  // после подтверждения в черновике не остаётся ФИО, телефона, кода и IP (чек-лист P0, 152-ФЗ)
  if (conf.status === 201) expect(await db.widgetDraft.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: 'CONFIRMED', name: '', phone: '', code: '', consentIp: null })
  return { status: conf.status, json: await conf.json(), draft }
}

beforeEach(async () => {
  db = await resetDb()
  mockProviders()
  productionEnv({ MAX_BOT_TOKEN: 'fake-token', MAX_BOT_NAME: 'fake_clinic_bot', MAX_WEBHOOK_SECRET: 'fake_secret_123', MAX_API_URL: 'https://max.mock' })
  delete process.env.SMARTCAPTCHA_SERVER_KEY
  process.env.WIDGET_ENABLED = '1'
  await db.documentTemplate.create({ data: { code: 'PD_CONSENT_WIDGET', name: 'Согласие', kind: 'CONSENT', body: CONSENT_TEXT } })
})

describe('Виджет онлайн-записи', () => {
  it('GET: без счётчиков для анонима, с текстом согласия, без записи в БД', async () => {
    const d = await makeDoctor(db, { workDays: '1111111' })
    const past = await db.widgetDraft.create({ data: { doctorId: d.id, start: new Date(), name: 'Фейк', phone: '79000000000', code: '111111', expiresAt: new Date(Date.now() - 60_000) } })
    const { GET } = await route()
    const res = await GET(req('GET'))
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j.stats).toBeNull()
    expect(j.consent.text).toBe(CONSENT_TEXT)
    expect((await db.widgetDraft.findUniqueOrThrow({ where: { id: past.id } })).status).toBe('PENDING') // GET ничего не меняет
  })

  it('без галочки согласия — 400; без утверждённого текста — 503; черновик не создаётся', async () => {
    const d = await makeDoctor(db, { workDays: '1111111' })
    const start = await slotTomorrow()
    const { POST } = await route()
    const r1 = await POST(req('POST', { action: 'init', doctorId: d.id, start: start.toISOString(), name: 'Фейков Тест', phone: '+79001110000' }))
    expect(r1.status).toBe(400)
    await db.documentTemplate.deleteMany({})
    const r2 = await POST(req('POST', { action: 'init', doctorId: d.id, start: start.toISOString(), name: 'Фейков Тест', phone: '+79001110000', consent: true }))
    expect(r2.status).toBe(503)
    expect(await db.widgetDraft.count()).toBe(0)
  })

  it('существующий пациент (8… в карте, +7… в виджете, та же фамилия): запись к нему, согласия сохранены, ссылка MAX', async () => {
    const d = await makeDoctor(db, { workDays: '1111111' })
    const existing = await db.patient.create({ data: { cardNumber: 'T-1', lastName: 'Фейкова', firstName: 'Анна', phone: '8 (900) 555-11-22' } })
    const r = await book(d.id, await slotTomorrow(), 'Фейкова Анна', '+7 900 555 11 22', { marketingConsent: true })
    expect(r.status).toBe(201)
    const appt = await db.appointment.findUniqueOrThrow({ where: { id: r.json.appointment.id } })
    expect(appt.patientId).toBe(existing.id)
    expect(await db.patient.count()).toBe(1)
    const p = await db.patient.findUniqueOrThrow({ where: { id: existing.id } })
    expect(p.pdConsentAt).not.toBeNull()
    expect(p.pdConsentSource).toBe('WIDGET')
    expect(p.marketingConsent).toBe(true)
    const recs = await db.consentRecord.findMany({ where: { patientId: existing.id }, orderBy: { kind: 'asc' } })
    expect(recs.map((x) => `${x.kind}:${x.action}`)).toEqual(['MARKETING:GIVEN', 'PD:GIVEN'])
    expect(recs.find((x) => x.kind === 'PD')!.textHash).toMatch(/^[0-9a-f]{64}$/)
    expect(recs.find((x) => x.kind === 'PD')!.ip).toMatch(/^203\.0\.113\./)
    expect(r.json.maxInviteUrl).toMatch(/^https:\/\/max\.ru\/fake_clinic_bot\?start=max_/)
  })

  it('тот же телефон, другая фамилия (член семьи) — новая карта, чужое имя в ответе не раскрывается', async () => {
    const d = await makeDoctor(db, { workDays: '1111111' })
    await db.patient.create({ data: { cardNumber: 'T-2', lastName: 'Фейкова', firstName: 'Мария', phone: '+79005553344' } })
    const r = await book(d.id, await slotTomorrow(11), 'Тестов Пётр', '89005553344')
    expect(r.status).toBe(201)
    expect(r.json.patientName).toBe('Тестов Пётр')
    expect(await db.patient.count()).toBe(2)
    const created = await db.patient.findFirstOrThrow({ where: { lastName: 'Тестов' } })
    expect(created.phone).toBe('79005553344')
    expect(created.pdConsentAt).not.toBeNull()
    expect(created.marketingConsent).toBe(false)
  })

  it('слот заняли, пока пациент вводил код — 409, пациенту не создаётся вторая запись', async () => {
    const d = await makeDoctor(db, { workDays: '1111111' })
    const start = await slotTomorrow(12)
    const { POST } = await route()
    const init = await (await POST(req('POST', { action: 'init', doctorId: d.id, start: start.toISOString(), name: 'Фейков Иван', phone: '+79007770000', consent: true }))).json()
    const other = await db.patient.create({ data: { cardNumber: 'T-3', lastName: 'Другой', firstName: 'Пациент', phone: '+79001112233' } })
    await db.appointment.create({ data: { patientId: other.id, doctorId: d.id, start } })
    const draft = await db.widgetDraft.findUniqueOrThrow({ where: { id: init.draftId } })
    const conf = await POST(req('POST', { action: 'confirm', draftId: draft.id, code: draft.code }))
    expect(conf.status).toBe(409)
    expect(await db.appointment.count({ where: { doctorId: d.id, start } })).toBe(1)
  })
})
