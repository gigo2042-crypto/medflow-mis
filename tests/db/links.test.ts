// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Чек-лист P1: подписанные ссылки пациента — отдельный LINK_SECRET, срок жизни и отзыв. Фейковые данные.
import { beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { makeDoctor, makePatient, mockProviders, productionEnv, resetDb, useTestDb } from './helpers'

useTestDb()
let db: Awaited<ReturnType<typeof resetDb>>

beforeEach(async () => {
  db = await resetDb()
  mockProviders()
  productionEnv({ LINK_SECRET: 'fake-link-secret-0123456789-abcdefghij' })
})

async function open(token: string) {
  const { GET } = await import('@/app/api/public/patient-link/route')
  return GET(new NextRequest(`https://mis.example.test/api/public/patient-link?t=${encodeURIComponent(token)}`))
}

describe('отзыв ссылок', () => {
  it('ссылка работает → отзыв → 404; новая ссылка после отзыва снова работает', async () => {
    const d = await makeDoctor(db)
    const p = await makePatient(db)
    const a = await db.appointment.create({ data: { patientId: p.id, doctorId: d.id, start: new Date(Date.now() + 2 * 86400_000), duration: 30, status: 'BOOKED', source: 'REGISTRAR' } })
    const { signLink } = await import('@/lib/patient-links')
    const { revokeLinks } = await import('@/lib/link-revocation')
    const old = signLink('ap', a.id, new Date(Date.now() - 5 * 60_000))
    expect((await open(old)).status).toBe(200)
    await revokeLinks('ap', a.id, 'тест')
    expect((await open(old)).status).toBe(404)
    const fresh = signLink('ap', a.id, new Date(Date.now() + 2 * 60_000)) // выпущена после отзыва
    expect((await open(fresh)).status).toBe(200)
  })
  it('обезличивание пациента отзывает ссылку отписки', async () => {
    const p = await makePatient(db, { marketingConsent: true })
    const { signLink } = await import('@/lib/patient-links')
    const t = signLink('u', p.id)
    expect((await open(t)).status).toBe(200)
    const { anonymizePatient } = await import('@/lib/consent')
    await anonymizePatient(p.id)
    expect((await open(t)).status).toBe(404)
  })
  it('ссылка, подписанная ключом от SESSION_SECRET (старая схема), не принимается', async () => {
    const p = await makePatient(db)
    const { signLink } = await import('@/lib/patient-links')
    const save = process.env.LINK_SECRET
    delete process.env.LINK_SECRET
    const t = signLink('u', p.id) // демо-фолбэк от SESSION_SECRET
    process.env.LINK_SECRET = save
    expect((await open(t)).status).toBe(404)
  })
})
