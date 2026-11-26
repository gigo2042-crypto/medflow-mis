// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Регрессия: ответы пациента без входящих SMS — подписанная ссылка (SMS) и кнопки/команды MAX;
// привязка MAX только через bot_started с подписанным payload; «СТОП» — отписка от рекламы.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { makeDoctor, makePatient, mockProviders, productionEnv, resetDb, useTestDb } from './helpers'

useTestDb()
let db: Awaited<ReturnType<typeof resetDb>>
let links: typeof import('@/lib/patient-links')
let webhook: typeof import('@/app/api/integrations/max/webhook/route')
let publicLink: typeof import('@/app/api/public/patient-link/route')
let calls: Array<{ url: string; body: string }>
const SECRET = 'fake_webhook_secret'

beforeAll(async () => {
  links = await import('@/lib/patient-links')
  webhook = await import('@/app/api/integrations/max/webhook/route')
  publicLink = await import('@/app/api/public/patient-link/route')
})

beforeEach(async () => {
  productionEnv({ MAX_BOT_TOKEN: 'fake', MAX_BOT_NAME: 'test_bot', MAX_WEBHOOK_SECRET: SECRET, MAX_API_URL: 'https://max.mock' })
  db = await resetDb()
  await db.notificationSetting.create({ data: { id: 'main', quietFrom: '00:00', quietTo: '00:00', dailyLimit: 1000 } })
  calls = mockProviders()
})

const hook = (body: unknown, secret = SECRET) =>
  webhook.POST(new NextRequest('https://mis.example.test/api/integrations/max/webhook', { method: 'POST', body: JSON.stringify(body), headers: { 'x-max-bot-api-secret': secret, 'content-type': 'application/json' } }))

async function futureAppointment(patientId: string) {
  const d = await makeDoctor(db)
  const start = new Date(Date.now() + 2 * 86400_000)
  start.setUTCHours(7, 0, 0, 0) // 10:00 МСК — внутри рабочего времени
  return db.appointment.create({ data: { patientId, doctorId: d.id, start, duration: 30 } })
}

describe('Вебхук MAX', () => {
  it('неверный секрет — 401, ничего не меняется', async () => {
    const p = await makePatient(db)
    const res = await hook({ update_type: 'bot_started', user: { user_id: 555 }, payload: links.signLink('max', p.id) }, 'wrong_secret')
    expect(res.status).toBe(401)
    expect((await db.patient.findUniqueOrThrow({ where: { id: p.id } })).maxUserId).toBeNull()
  })

  it('bot_started с подписанным payload — привязка; без payload — нет', async () => {
    const p = await makePatient(db)
    expect((await hook({ update_type: 'bot_started', user: { user_id: 555 }, payload: null })).status).toBe(200)
    expect((await db.patient.findUniqueOrThrow({ where: { id: p.id } })).maxUserId).toBeNull()
    await hook({ update_type: 'bot_started', user: { user_id: 555 }, payload: `max_${p.id}_AAAAAAAAAAAAAAAA` })
    expect((await db.patient.findUniqueOrThrow({ where: { id: p.id } })).maxUserId).toBeNull()
    await hook({ update_type: 'bot_started', user: { user_id: 555 }, payload: links.signLink('max', p.id) })
    expect((await db.patient.findUniqueOrThrow({ where: { id: p.id } })).maxUserId).toBe('555')
    await hook({ update_type: 'bot_stopped', user: { user_id: 555 } })
    expect((await db.patient.findUniqueOrThrow({ where: { id: p.id } })).maxUserId).toBeNull()
  })

  it('кнопка «Подтверждаю» — только от привязанного владельца записи', async () => {
    const owner = await makePatient(db, { maxUserId: '1001' })
    await makePatient(db, { maxUserId: '2002' })
    const a = await futureAppointment(owner.id)
    const t = links.signLink('ap', a.id)
    await hook({ update_type: 'message_callback', callback: { callback_id: 'cb1', payload: `ok:${t}`, user: { user_id: 2002 } } })
    expect((await db.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('BOOKED')
    await hook({ update_type: 'message_callback', callback: { callback_id: 'cb2', payload: `ok:${t}`, user: { user_id: 1001 } } })
    expect((await db.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('CONFIRMED')
    expect(calls.some((c) => c.url.includes('/answers?callback_id=cb2'))).toBe(true)
  })

  it('«СТОП» — отзыв согласия на рекламу с записью в истории согласий', async () => {
    const p = await makePatient(db, { maxUserId: '3003', marketingConsent: true })
    await hook({ update_type: 'message_created', message: { sender: { user_id: 3003 }, body: { text: ' Стоп ' } } })
    expect((await db.patient.findUniqueOrThrow({ where: { id: p.id } })).marketingConsent).toBe(false)
    expect(await db.consentRecord.count({ where: { patientId: p.id, kind: 'MARKETING', action: 'REVOKED', source: 'MAX' } })).toBe(1)
  })
})

describe('Страница ответа по ссылке из SMS', () => {
  const get = (t: string) => publicLink.GET(new NextRequest(`https://mis.example.test/api/public/patient-link?t=${encodeURIComponent(t)}`))
  const post = (t: string, action: string) =>
    publicLink.POST(new NextRequest('https://mis.example.test/api/public/patient-link', { method: 'POST', body: JSON.stringify({ t, action }), headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.7' } }))

  it('GET без побочных эффектов и без ПДн; POST cancel отменяет запись (идемпотентно)', async () => {
    const p = await makePatient(db)
    const a = await futureAppointment(p.id)
    const t = links.signLink('ap', a.id)
    const g = await get(t)
    const info = await g.json()
    expect(info.actions).toEqual(['confirm', 'cancel'])
    expect(JSON.stringify(info)).not.toContain(p.lastName)
    expect((await db.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('BOOKED')
    expect((await post(t, 'cancel')).status).toBe(200)
    expect((await db.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('CANCELED')
    const again = await post(t, 'cancel')
    expect((await again.json()).message).toMatch(/уже отменена/)
  })

  it('поддельная ссылка — 404', async () => {
    expect((await get('ap_cmfake_AAAAAAAAAAAAAAAA')).status).toBe(404)
    expect((await post('u_cmfake_AAAAAAAAAAAAAAAA', 'unsubscribe')).status).toBe(404)
  })

  it('отписка по ссылке из рассылки', async () => {
    const p = await makePatient(db, { marketingConsent: true })
    expect((await post(links.signLink('u', p.id), 'unsubscribe')).status).toBe(200)
    expect((await db.patient.findUniqueOrThrow({ where: { id: p.id } })).marketingConsent).toBe(false)
  })
})
