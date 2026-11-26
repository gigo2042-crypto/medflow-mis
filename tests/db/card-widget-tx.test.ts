// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Чек-лист P1: единая нумерация карт (последовательность, без выгрузки картотеки) и запись из виджета
// одной транзакцией (пациент + приём + согласие + напоминания + захват черновика). Только фейковые данные.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { authed, makeDoctor, mockProviders, productionEnv, resetDb, staffSession, useTestDb } from './helpers'

const fail = { cascade: false }
vi.mock('@/lib/reminders', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    createCascade: async (...args: unknown[]) => {
      if (fail.cascade) throw new Error('тестовый сбой каскада напоминаний')
      return (real.createCascade as (...a: unknown[]) => Promise<number>)(...args)
    },
  }
})

useTestDb()
let db: Awaited<ReturnType<typeof resetDb>>
let ipSeq = 0

function wreq(body: unknown) {
  ipSeq++
  return new NextRequest('https://mis.example.test/api/widget', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${ipSeq % 250}` },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  db = await resetDb()
  mockProviders()
  productionEnv()
  delete process.env.SMARTCAPTCHA_SERVER_KEY
  process.env.WIDGET_ENABLED = '1'
  fail.cascade = false
  await db.documentTemplate.create({ data: { code: 'PD_CONSENT_WIDGET', name: 'Согласие', kind: 'CONSENT', body: 'Фейковый текст согласия для тестов.' } })
})

async function slotTomorrow(hour = 11) {
  const { addDaysKey, todayKey, zonedTime, parseDateKey } = await import('@/lib/mis-utils')
  const k = parseDateKey(addDaysKey(todayKey(), 1))!
  return zonedTime(k.y, k.m, k.d, hour, 0)
}

describe('нумерация карт', () => {
  it('20 параллельных созданий → 20 разных номеров подряд, картотека не выгружается', async () => {
    const { createPatientWithCard, syncCardSequence } = await import('@/lib/patients')
    const { db: appDb } = await import('@/lib/db')
    await syncCardSequence()
    const spy = vi.spyOn(appDb.patient, 'findMany')
    const ps = await Promise.all(Array.from({ length: 20 }, (_, i) => createPatientWithCard({ lastName: 'Фейков', firstName: `П${i}`, phone: `+7900000${String(i).padStart(4, '0')}` })))
    expect(spy).not.toHaveBeenCalled()
    const nums = ps.map((p) => Number(p.cardNumber.slice(3))).sort((a, b) => a - b)
    expect(new Set(nums).size).toBe(20)
    expect(nums[19] - nums[0]).toBe(19)
    expect(nums[0]).toBe(1001)
  })
  it('ручной/импортированный номер выше последовательности → следующий номер без конфликта', async () => {
    const { createPatientWithCard, syncCardSequence } = await import('@/lib/patients')
    await syncCardSequence()
    await createPatientWithCard({ lastName: 'Фейков', firstName: 'А', phone: '+79000000001' })
    await db.patient.create({ data: { cardNumber: 'MF-1002', lastName: 'Импорт', firstName: 'Б', phone: '+79000000002' } })
    await db.patient.create({ data: { cardNumber: 'MF-5000', lastName: 'Импорт', firstName: 'В', phone: '+79000000003' } })
    const next = await createPatientWithCard({ lastName: 'Фейков', firstName: 'Г', phone: '+79000000004' })
    expect(next.cardNumber).toBe('MF-5001')
  })
  it('регистратура: карта и согласие — вместе', async () => {
    const reg = await staffSession(db, 'REGISTRAR')
    const { POST } = await import('@/app/api/patients/route')
    const r = await POST(await authed(reg.cookie, 'POST', '/api/patients', { lastName: 'Фейкова', firstName: 'Дарья', phone: '+7 900 123-45-67', gender: 'F', pdConsent: true }))
    expect(r.status).toBe(201)
    const { patient } = await r.json()
    expect(patient.cardNumber).toMatch(/^MF-\d+$/)
    expect(await db.consentRecord.count({ where: { patientId: patient.id, kind: 'PD' } })).toBe(1)
  })
})

describe('виджет: запись одной транзакцией', () => {
  async function init(doctorId: string, phone = '+79005550101') {
    const { POST } = await import('@/app/api/widget/route')
    const start = await slotTomorrow()
    const r = await POST(wreq({ action: 'init', doctorId, start: start.toISOString(), name: 'Фейкова Ирина', phone, consent: true }))
    expect(r.status).toBe(200)
    const { draftId } = await r.json()
    return db.widgetDraft.findUniqueOrThrow({ where: { id: draftId } })
  }

  it('сбой посреди записи → нет ни пациента, ни приёма, ни согласия; черновик остаётся, повтор кода проходит', async () => {
    const d = await makeDoctor(db, { workDays: '1111111' })
    const draft = await init(d.id)
    const { POST } = await import('@/app/api/widget/route')
    fail.cascade = true
    const bad = await POST(wreq({ action: 'confirm', draftId: draft.id, code: draft.code }))
    expect(bad.status).toBe(500)
    expect(await db.patient.count()).toBe(0)
    expect(await db.appointment.count()).toBe(0)
    expect(await db.consentRecord.count()).toBe(0)
    expect((await db.widgetDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('PENDING')
    fail.cascade = false
    const ok = await POST(wreq({ action: 'confirm', draftId: draft.id, code: draft.code }))
    expect(ok.status).toBe(201)
    expect(await db.patient.count()).toBe(1)
    expect(await db.appointment.count()).toBe(1)
    expect(await db.consentRecord.count({ where: { kind: 'PD', source: 'WIDGET' } })).toBe(1)
  })

  it('два одновременных подтверждения верным кодом → одна запись, один пациент; второй — 409', async () => {
    const d = await makeDoctor(db, { workDays: '1111111' })
    const draft = await init(d.id, '+79005550202')
    const { POST } = await import('@/app/api/widget/route')
    const rs = await Promise.all([1, 2, 3].map(() => POST(wreq({ action: 'confirm', draftId: draft.id, code: draft.code }))))
    const st = rs.map((r) => r.status).sort()
    expect(st.filter((s) => s === 201)).toHaveLength(1)
    expect(st.filter((s) => s === 201).length + st.filter((s) => s === 409 || s === 400).length).toBe(3)
    expect(await db.appointment.count()).toBe(1)
    expect(await db.patient.count()).toBe(1)
    expect((await db.widgetDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('CONFIRMED')
  })
})
