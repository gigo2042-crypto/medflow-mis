// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Регрессия: Центр уведомлений — нет двойной отправки при параллельных воркерах;
// MAX с фолбэком на SMS; статусы напоминаний; служебные оповещения без выдуманного телефона.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { makePatient, mockProviders, productionEnv, resetDb, useTestDb } from './helpers'

useTestDb()
let db: Awaited<ReturnType<typeof resetDb>>
let notify: typeof import('@/lib/notify')
let calls: Array<{ url: string; body: string }>

beforeAll(async () => {
  notify = await import('@/lib/notify')
})

beforeEach(async () => {
  productionEnv()
  for (const k of ['MAX_BOT_TOKEN', 'MAX_BOT_NAME', 'MAX_WEBHOOK_SECRET', 'MAX_API_URL', 'STAFF_ALERT_EMAIL']) delete process.env[k]
  db = await resetDb()
  // часы тишины выключены (окно нулевой длины), лимит большой
  await db.notificationSetting.create({ data: { id: 'main', quietFrom: '00:00', quietTo: '00:00', dailyLimit: 1000, retryMinutes: 5, maxAttempts: 3 } })
  calls = mockProviders()
})

describe('Центр уведомлений', () => {
  it('параллельные воркеры не отправляют одно сообщение дважды (FOR UPDATE SKIP LOCKED)', async () => {
    const p = await makePatient(db)
    for (let i = 0; i < 12; i++) await notify.enqueue({ kind: 'MANUAL', channel: 'SMS', phone: p.phone, text: `msg-${i}`, patientId: p.id })
    const results = await Promise.all([notify.processOutbox(), notify.processOutbox(), notify.processOutbox(), notify.processOutbox()])
    const sentTotal = results.reduce((s, r) => s + r.sent, 0)
    expect(sentTotal).toBe(12)
    const smsCalls = calls.filter((c) => c.url.includes('sms.mock'))
    expect(smsCalls).toHaveLength(12)
    const texts = smsCalls.map((c) => new URLSearchParams(c.body).get('msg'))
    expect(new Set(texts).size).toBe(12)
    expect(await db.notification.count({ where: { status: 'SENT' } })).toBe(12)
  })

  it('захват истёк (воркер упал) — сообщение возвращается в работу', async () => {
    const p = await makePatient(db)
    const q = await notify.enqueue({ kind: 'MANUAL', channel: 'SMS', phone: p.phone, text: 'stale', patientId: p.id })
    await db.notification.update({ where: { id: q.id }, data: { status: 'SENDING', lockedUntil: new Date(Date.now() - 1000) } })
    const r = await notify.processOutbox()
    expect(r.sent).toBe(1)
  })

  it('MAX не настроен → SMS (fallbackFrom=MAX)', async () => {
    const p = await makePatient(db, { maxUserId: '111' })
    const q = await notify.enqueue({ kind: 'MANUAL', channel: 'MAX', phone: p.phone, text: 'hello', patientId: p.id })
    await notify.processOutbox()
    const n = await db.notification.findUniqueOrThrow({ where: { id: q.id } })
    expect(n).toMatchObject({ status: 'SENT', channel: 'SMS', fallbackFrom: 'MAX' })
    expect(calls.some((c) => c.url.includes('max.mock'))).toBe(false)
  })

  it('MAX настроен, пациент не привязан → SMS', async () => {
    productionEnv({ MAX_BOT_TOKEN: 'fake', MAX_BOT_NAME: 'bot', MAX_WEBHOOK_SECRET: 'secret_123', MAX_API_URL: 'https://max.mock' })
    const p = await makePatient(db)
    const q = await notify.enqueue({ kind: 'MANUAL', channel: 'MAX', phone: p.phone, text: 'hello', patientId: p.id })
    await notify.processOutbox()
    expect(await db.notification.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ status: 'SENT', channel: 'SMS', fallbackFrom: 'MAX' })
  })

  it('MAX настроен и пациент привязан → MAX с кнопками ответа', async () => {
    productionEnv({ MAX_BOT_TOKEN: 'fake', MAX_BOT_NAME: 'bot', MAX_WEBHOOK_SECRET: 'secret_123', MAX_API_URL: 'https://max.mock' })
    const p = await makePatient(db, { maxUserId: '777' })
    const q = await notify.enqueue({ kind: 'RISK_TOUCH', channel: 'MAX', phone: p.phone, text: 'confirm?', patientId: p.id, relatedAppointmentId: 'cmfakeappt1' })
    await notify.processOutbox()
    expect(await db.notification.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ status: 'SENT', channel: 'MAX', fallbackFrom: null })
    const maxCall = calls.find((c) => c.url.includes('max.mock/messages?user_id=777'))!
    expect(JSON.parse(maxCall.body).attachments[0].payload.buttons[0].map((b: { text: string }) => b.text)).toEqual(['Подтверждаю', 'Отменить'])
    expect(calls.some((c) => c.url.includes('sms.mock'))).toBe(false)
  })

  it('MAX отвечает постоянной ошибкой (бот остановлен) → сразу SMS', async () => {
    productionEnv({ MAX_BOT_TOKEN: 'fake', MAX_BOT_NAME: 'bot', MAX_WEBHOOK_SECRET: 'secret_123', MAX_API_URL: 'https://max.mock' })
    const p = await makePatient(db, { maxUserId: '404' })
    const q = await notify.enqueue({ kind: 'MANUAL', channel: 'MAX', phone: p.phone, text: 'x', patientId: p.id })
    await notify.processOutbox()
    expect(await db.notification.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ status: 'SENT', channel: 'SMS', fallbackFrom: 'MAX' })
  })

  it('доставка напоминания сразу переводит Reminder в SENT', async () => {
    const p = await makePatient(db)
    const d = await db.doctor.create({ data: { name: 'Д', specialty: 'Терапевт' } })
    const a = await db.appointment.create({ data: { patientId: p.id, doctorId: d.id, start: new Date(Date.now() + 86400_000) } })
    const r = await db.reminder.create({ data: { appointmentId: a.id, level: 1, plannedAt: new Date(), text: 't' } })
    await notify.enqueue({ kind: 'REMINDER', channel: 'SMS', phone: p.phone, text: 't', patientId: p.id, relatedReminderId: r.id, relatedAppointmentId: a.id })
    await notify.processOutbox()
    expect((await db.reminder.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('SENT')
    // второе сообщение на то же напоминание запрещено уникальным индексом
    await expect(notify.enqueue({ kind: 'REMINDER', channel: 'SMS', phone: p.phone, text: 't', relatedReminderId: r.id })).rejects.toThrow()
  })

  it('служебное оповещение без STAFF_ALERT_EMAIL — только журнал, без отправки', async () => {
    const r = await notify.staffAlert('STOCK_LOW', 'Склад: тест')
    expect(r.status).toBe('INBOX')
    await notify.processOutbox()
    expect(calls).toHaveLength(0)
  })
})
