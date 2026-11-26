// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Чек-лист P0 «ИИ-протоколы»: внешний LLM без явного флага не используется; врач видит превью,
// в модель уходит ровно подтверждённый текст без ФИО и телефона. Живых вызовов LLM нет:
// «модель» — мок fetch на локальный адрес. Данные пациента — вымышленные.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authed, makeDoctor, makePatient, makeVisit, productionEnv, resetDb, staffSession, useTestDb } from './helpers'

useTestDb()
let db: Awaited<ReturnType<typeof resetDb>>
const sent: Array<{ url: string; body: string }> = []

beforeEach(async () => {
  db = await resetDb()
  productionEnv()
  sent.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? '') })
    const text = 'Жалобы: боль.\nАнамнез: не указан.\nОбъективно: кариес.\nДиагноз (МКБ-10): K02.1 Кариес дентина\nПлан лечения: пломба.'
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }))
  }))
  for (const k of ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_EXTERNAL_ALLOWED', 'YANDEX_API_KEY', 'YANDEX_FOLDER_ID']) delete process.env[k]
})

async function setup() {
  const doctor = await makeDoctor(db)
  const patient = await makePatient(db, { lastName: 'Вымыслов', firstName: 'Тимофей', middleName: 'Петрович', phone: '+7 900 555-44-33', email: 'fake.patient@example.test' })
  const visit = await makeVisit(db, patient.id, doctor.id)
  const doc = await staffSession(db, 'DOCTOR', { doctorId: doctor.id })
  const body = {
    visitId: visit.id,
    specialty: 'Стоматолог',
    diagnosisCode: 'K02.1',
    complaints: 'Вымыслову Тимофею Петровичу больно, у Вымыслова жалобы с понедельника, тел. 89005554433',
    notes: 'Сопровождает жена Вымыслова Ольга, живут ул. Фейковая, д. 1, кв. 2, работает в ООО «Тестовая Компания»',
  }
  return { doc, body, patient, visit }
}

describe('ИИ: превью и запрет внешних провайдеров', () => {
  it('локальная модель: первый запрос — превью без отправки, затем отправка ровно подтверждённого текста', async () => {
    Object.assign(process.env, { LLM_PROVIDER: 'openai', LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_API_KEY: 'fake', LLM_MODEL: 'fake' })
    const { doc, body } = await setup()
    const { POST } = await import('@/app/api/ai/protocol/route')
    const r1 = await POST(await authed(doc.cookie, 'POST', '/api/ai/protocol', body))
    const j1 = await r1.json()
    expect(j1.needConfirm).toBe(true)
    expect(sent).toHaveLength(0) // в модель ничего не ушло
    for (const bad of ['Вымысл', 'Тимоф', 'Петрович', '555', 'Ольга', 'Фейковая', 'Тестовая Компания']) expect(j1.preview).not.toContain(bad)
    expect(j1.target).toEqual({ provider: 'openai', external: false })

    // чужой/устаревший хеш — снова превью, без отправки
    const r2 = await POST(await authed(doc.cookie, 'POST', '/api/ai/protocol', { ...body, confirmHash: 'x'.repeat(64) }))
    expect((await r2.json()).changed).toBe(true)
    expect(sent).toHaveLength(0)

    const r3 = await POST(await authed(doc.cookie, 'POST', '/api/ai/protocol', { ...body, confirmHash: j1.previewHash }))
    const j3 = await r3.json()
    expect(j3.ai).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toContain('127.0.0.1')
    const payload = JSON.parse(sent[0].body)
    expect(payload.messages[1].content).toBe(j1.preview)
    expect(await db.auditLog.count({ where: { action: 'ai.protocol_sent' } })).toBe(1)
  })

  it('внешний провайдер без LLM_EXTERNAL_ALLOWED: запросов наружу нет, черновик по шаблону', async () => {
    Object.assign(process.env, { LLM_PROVIDER: 'yandexgpt', YANDEX_API_KEY: 'fake', YANDEX_FOLDER_ID: 'fake' })
    const { doc, body } = await setup()
    const { POST } = await import('@/app/api/ai/protocol/route')
    const j = await (await POST(await authed(doc.cookie, 'POST', '/api/ai/protocol', body))).json()
    expect(j.ai).toBe(false)
    expect(j.needConfirm).toBeUndefined()
    expect(sent).toHaveLength(0)
    const { validateEnv } = await import('../../scripts/env-rules.mjs')
    expect(validateEnv({ ...process.env }).join('\n')).toMatch(/LLM_EXTERNAL_ALLOWED/)
  })

  it('OpenAI-совместимый API во внешней сети — тоже внешний; с явным флагом — превью', async () => {
    Object.assign(process.env, { LLM_PROVIDER: 'openai', LLM_BASE_URL: 'https://api.llm.example.com/v1', LLM_API_KEY: 'fake', LLM_MODEL: 'fake' })
    const { doc, body } = await setup()
    const { POST } = await import('@/app/api/ai/protocol/route')
    expect((await (await POST(await authed(doc.cookie, 'POST', '/api/ai/protocol', body))).json()).ai).toBe(false)
    process.env.LLM_EXTERNAL_ALLOWED = '1'
    const j = await (await POST(await authed(doc.cookie, 'POST', '/api/ai/protocol', body))).json()
    expect(j.needConfirm).toBe(true)
    expect(j.target).toEqual({ provider: 'openai', external: true })
    expect(sent).toHaveLength(0)
  })

  it('резюме истории: тоже превью, без ФИО/телефона, отправка после подтверждения', async () => {
    Object.assign(process.env, { LLM_PROVIDER: 'openai', LLM_BASE_URL: 'http://llm.internal:8000/v1', LLM_API_KEY: 'fake', LLM_MODEL: 'fake' })
    const { doc, patient, visit } = await setup()
    await db.visit.update({ where: { id: visit.id }, data: { complaints: 'Вымыслов звонил с 8 900 555 44 33, просит перезвонить' } })
    const { POST } = await import('@/app/api/ai/summary/route')
    const j1 = await (await POST(await authed(doc.cookie, 'POST', '/api/ai/summary', { patientId: patient.id }))).json()
    expect(j1.needConfirm).toBe(true)
    expect(j1.preview).not.toMatch(/Вымысл|555/)
    expect(sent).toHaveLength(0)
    const j2 = await (await POST(await authed(doc.cookie, 'POST', '/api/ai/summary', { patientId: patient.id, confirmHash: j1.previewHash }))).json()
    expect(j2.ai).toBe(true)
    expect(sent).toHaveLength(1)
  })
})
