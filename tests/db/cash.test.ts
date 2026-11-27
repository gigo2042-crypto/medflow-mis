// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Чек-лист P0 «Касса» (54-ФЗ). Только фейковые данные; живых вызовов АТОЛ нет (касса не настроена / демо-режим).
//  • два одновременных POST на один визит → одна оплата; повтор с тем же clientKey → та же оплата;
//  • возврат неотправленного чека при подключённой кассе → 409; без провайдера в production — запись возврата; отмена неотправленной оплаты; возврат в транзакции, P2002 → 409;
//  • валидация сумм (NaN/Infinity/строки/дроби/пределы); лимит скидки и одноразовый код администратора с аудитом.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authed, makeDoctor, makePatient, makeVisit, productionEnv, resetDb, staffSession, useTestDb } from './helpers'

useTestDb()
let db: Awaited<ReturnType<typeof resetDb>>

// Фейковые реквизиты АТОЛ — как в tests/unit/fiscal-clinic.test.ts; живой кассы нет.
const ATOL_CONNECTED = {
  FISCAL_PROVIDER: 'atol',
  ATOL_LOGIN: 'fake-login',
  ATOL_PASSWORD: 'fake-pass',
  ATOL_GROUP_CODE: 'fake-group',
  ATOL_SNO: 'usn_income',
  ATOL_PAYMENT_ADDRESS: 'https://clinic.example',
  ATOL_COMPANY_EMAIL: 'kassa@clinic.example',
  ATOL_BASE_URL: 'https://atol.mock/possystem/v5',
  CLINIC_INN: '7700000000',
}

beforeEach(async () => {
  db = await resetDb()
  productionEnv()
  delete process.env.DISCOUNT_MAX_PERCENT
  delete process.env.PAYMENT_MAX_RUB
  for (const k of Object.keys(ATOL_CONNECTED)) delete process.env[k]
  vi.restoreAllMocks()
})

async function setup() {
  const doctor = await makeDoctor(db)
  const patient = await makePatient(db)
  const service = await db.serviceItem.create({ data: { name: 'Приём (тест)', category: 'Приём', price: 2000 } })
  const visit = await makeVisit(db, patient.id, doctor.id, { serviceId: service.id, price: 2000 })
  const reg = await staffSession(db, 'REGISTRAR')
  const admin = await staffSession(db, 'ADMIN')
  return { patient, visit, service, reg, admin }
}
async function pay(cookie: string, body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/payments/route')
  const r = await POST(await authed(cookie, 'POST', '/api/payments', body))
  return { status: r.status, json: await r.json() }
}
async function patch(cookie: string, id: string, action: string) {
  const { PATCH } = await import('@/app/api/payments/[id]/route')
  const r = await PATCH(await authed(cookie, 'PATCH', `/api/payments/${id}`, { action }), { params: Promise.resolve({ id }) })
  return { status: r.status, json: await r.json() }
}

describe('идемпотентность оплаты', () => {
  it('два (и десять) одновременных POST на один визит → одна оплата', async () => {
    const { patient, visit, reg } = await setup()
    const two = await Promise.all([1, 2].map(() => pay(reg.cookie, { patientId: patient.id, visitId: visit.id, method: 'CARD' })))
    expect(two.map((r) => r.status).sort()).toEqual([201, 409])
    const ten = await Promise.all(Array.from({ length: 10 }, () => pay(reg.cookie, { patientId: patient.id, visitId: visit.id, method: 'CASH' })))
    expect(ten.every((r) => r.status === 409)).toBe(true)
    expect(await db.payment.count({ where: { visitId: visit.id } })).toBe(1)
  })
  it('повтор с тем же clientKey (без визита) → та же оплата, не вторая', async () => {
    const { patient, reg } = await setup()
    const body = { patientId: patient.id, amount: 1500, clientKey: 'pay-key-test-00000001' }
    const rs = await Promise.all(Array.from({ length: 5 }, () => pay(reg.cookie, body)))
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1)
    expect(rs.every((r) => [200, 201].includes(r.status))).toBe(true)
    expect(new Set(rs.map((r) => r.json.payment.id)).size).toBe(1)
    expect(await db.payment.count()).toBe(1)
  })
  it('после отмены оплаты по приёму можно принять оплату заново', async () => {
    const { patient, visit, reg, admin } = await setup()
    const a = await pay(reg.cookie, { patientId: patient.id, visitId: visit.id })
    expect((await patch(admin.cookie, a.json.payment.id, 'cancel')).status).toBe(200)
    expect((await pay(reg.cookie, { patientId: patient.id, visitId: visit.id })).status).toBe(201)
  })
})

describe('возврат только по пробитому чеку', () => {
  it('возврат неотправленного чека → 409 NOT_FISCALIZED; отмена → CANCELED, в кассу не уходит', async () => {
    productionEnv(ATOL_CONNECTED)
    const { patient, reg, admin } = await setup()
    const p = (await pay(reg.cookie, { patientId: patient.id, amount: 1000 })).json.payment
    const r = await patch(admin.cookie, p.id, 'refund')
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('NOT_FISCALIZED')
    expect(await db.payment.count({ where: { type: 'REFUND' } })).toBe(0)
    for (const fs of ['PENDING']) {
      await db.payment.update({ where: { id: p.id }, data: { fiscalStatus: fs } })
      expect((await patch(admin.cookie, p.id, 'refund')).status).toBe(409)
      expect((await patch(admin.cookie, p.id, 'cancel')).status).toBe(409) // в кассе — отменять нельзя
    }
    await db.payment.update({ where: { id: p.id }, data: { fiscalStatus: 'ERROR' } })
    expect((await patch(admin.cookie, p.id, 'cancel')).status).toBe(200)
    expect(await db.payment.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status: 'CANCELED', fiscalStatus: 'CANCELED' })
    const f = await patch(admin.cookie, p.id, 'fiscalize')
    expect(f.status).toBe(409)
    expect(await db.auditLog.count({ where: { action: 'payment.canceled' } })).toBe(1)
  })
  it('без провайдера в production возврат по непробитому чеку → 201 и запись возврата создаётся', async () => {
    const { patient, reg, admin } = await setup()
    const p = (await pay(reg.cookie, { patientId: patient.id, amount: 1000 })).json.payment
    const r = await patch(admin.cookie, p.id, 'refund')
    expect(r.status).toBe(201)
    expect(await db.payment.count({ where: { type: 'REFUND', refundOfId: p.id } })).toBe(1)
  })
  it('регистратор не отменяет и не возвращает (cash.refund только у администратора)', async () => {
    const { patient, reg } = await setup()
    const p = (await pay(reg.cookie, { patientId: patient.id, amount: 1000 })).json.payment
    expect((await patch(reg.cookie, p.id, 'cancel')).status).toBe(403)
    expect((await patch(reg.cookie, p.id, 'refund')).status).toBe(403)
  })
  it('возврат пробитого чека: 5 параллельных запросов → один возврат, исходная оплата CANCELED', async () => {
    const { patient, reg, admin } = await setup()
    const p = (await pay(reg.cookie, { patientId: patient.id, amount: 1000 })).json.payment
    await db.payment.update({ where: { id: p.id }, data: { fiscalStatus: 'ISSUED', fiscalNumber: 'ФН-ТЕСТ' } })
    const rs = await Promise.all(Array.from({ length: 5 }, () => patch(admin.cookie, p.id, 'refund')))
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1)
    expect(rs.filter((r) => r.status === 409)).toHaveLength(4)
    expect(await db.payment.count({ where: { type: 'REFUND', refundOfId: p.id } })).toBe(1)
    expect((await db.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('CANCELED')
  })
  it('P2002 по refundOfId внутри транзакции → 409, а не 500; исходная оплата не меняется', async () => {
    const { patient, reg, admin } = await setup()
    const p = (await pay(reg.cookie, { patientId: patient.id, amount: 1000 })).json.payment
    await db.payment.update({ where: { id: p.id }, data: { fiscalStatus: 'ISSUED' } })
    const { db: appDb } = await import('@/lib/db')
    vi.spyOn(appDb, '$transaction').mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed on refundOfId'), { code: 'P2002' }))
    const r = await patch(admin.cookie, p.id, 'refund')
    expect(r.status).toBe(409)
    expect((await db.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('PAID')
  })
})

describe('фискализация: атомарный захват', () => {
  it('два одновременных «Фискализировать» (демо-касса) → один чек, второй 409', async () => {
    const { patient, reg } = await setup()
    const p = (await pay(reg.cookie, { patientId: patient.id, amount: 1000 })).json.payment
    process.env.APP_MODE = 'demo'
    const rs = await Promise.all([1, 2].map(() => patch(reg.cookie, p.id, 'fiscalize')))
    process.env.APP_MODE = 'production'
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409])
  })
})

describe('валидация суммы', () => {
  it('NaN/Infinity (в JSON — null), строки, дроби, ноль, отрицательные, сверх предела — 400', async () => {
    const { patient, reg, service } = await setup()
    const bad: unknown[] = [null, '1500', '1e400', 10.5, 0, -5, 2_000_000, Number.MAX_SAFE_INTEGER, true, { v: 1 }]
    for (const amount of bad) {
      const r = await pay(reg.cookie, { patientId: patient.id, amount })
      expect(r.status, `amount=${JSON.stringify(amount)}`).toBe(400)
    }
    for (const qty of [1.5, 0, 101, '2', -1]) {
      expect((await pay(reg.cookie, { patientId: patient.id, items: [{ serviceId: service.id, qty }] })).status, `qty=${qty}`).toBe(400)
    }
    for (const discount of ['abc', -1, 1.5, 1500]) {
      expect((await pay(reg.cookie, { patientId: patient.id, amount: 1500, discount })).status, `discount=${discount}`).toBe(400)
    }
    expect(await db.payment.count()).toBe(0)
    expect((await pay(reg.cookie, { patientId: patient.id, amount: 1500 })).status).toBe(201)
    process.env.PAYMENT_MAX_RUB = '1000'
    expect((await pay(reg.cookie, { patientId: patient.id, amount: 1001 })).status).toBe(400)
  })
})

describe('лимит скидки и подтверждение администратора', () => {
  it('в пределах 10% — без кода; сверх — 403 и аудит; с кодом администратора — 201 и аудит; код одноразовый', async () => {
    const { patient, reg, admin } = await setup()
    expect((await pay(reg.cookie, { patientId: patient.id, amount: 1000, discount: 100 })).status).toBe(201)
    const denied = await pay(reg.cookie, { patientId: patient.id, amount: 1000, discount: 500 })
    expect(denied.status).toBe(403)
    expect(denied.json.code).toBe('DISCOUNT_APPROVAL_REQUIRED')
    expect(await db.auditLog.count({ where: { action: 'payment.discount_denied' } })).toBe(1)

    const { POST: approve } = await import('@/app/api/payments/discount-approvals/route')
    expect((await approve(await authed(reg.cookie, 'POST', '/api/payments/discount-approvals', { patientId: patient.id, maxDiscount: 500, reason: 'акция' }))).status).toBe(403)
    const ar = await approve(await authed(admin.cookie, 'POST', '/api/payments/discount-approvals', { patientId: patient.id, maxDiscount: 500, reason: 'акция «Тест»' }))
    expect(ar.status).toBe(201)
    const code = (await ar.json()).approval.code as string

    expect((await pay(reg.cookie, { patientId: patient.id, amount: 1000, discount: 600, discountApprovalCode: code })).status).toBe(403) // больше одобренного
    const other = await makePatient(db)
    expect((await pay(reg.cookie, { patientId: other.id, amount: 1000, discount: 500, discountApprovalCode: code })).status).toBe(403) // другой пациент
    const ok = await pay(reg.cookie, { patientId: patient.id, amount: 1000, discount: 500, discountApprovalCode: code.toLowerCase() })
    expect(ok.status).toBe(201)
    expect(ok.json.payment.amount).toBe(500)
    expect(await db.auditLog.count({ where: { action: 'payment.discount_approved' } })).toBe(1)
    expect(await db.auditLog.count({ where: { action: 'payment.discount_approval_created' } })).toBe(1)
    expect((await pay(reg.cookie, { patientId: patient.id, amount: 1000, discount: 500, discountApprovalCode: code })).status).toBe(403) // повтор кода
  })
  it('параллельное использование одного кода → одна оплата со скидкой', async () => {
    const { patient, reg, admin } = await setup()
    const { POST: approve } = await import('@/app/api/payments/discount-approvals/route')
    const code = (await (await approve(await authed(admin.cookie, 'POST', '/api/payments/discount-approvals', { patientId: patient.id, maxDiscount: 500, reason: 'акция' }))).json()).approval.code
    const rs = await Promise.all(Array.from({ length: 5 }, () => pay(reg.cookie, { patientId: patient.id, amount: 1000, discount: 500, discountApprovalCode: code })))
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1)
    expect(await db.payment.count({ where: { discount: 500 } })).toBe(1)
  })
  it('истёкший код — отказ; администратор даёт большую скидку сам; DISCOUNT_MAX_PERCENT настраивается', async () => {
    const { patient, reg, admin } = await setup()
    await db.discountApproval.create({ data: { code: 'EXPIRED22', patientId: patient.id, maxDiscount: 900, createdById: admin.user.id, expiresAt: new Date(Date.now() - 1000) } })
    expect((await pay(reg.cookie, { patientId: patient.id, amount: 1000, discount: 900, discountApprovalCode: 'EXPIRED22' })).status).toBe(403)
    expect((await pay(admin.cookie, { patientId: patient.id, amount: 1000, discount: 900 })).status).toBe(201)
    process.env.DISCOUNT_MAX_PERCENT = '0'
    expect((await pay(reg.cookie, { patientId: patient.id, amount: 1000, discount: 1 })).status).toBe(403)
  })
})

// Ревью ocr (находки 2, 3, 5, 6): возврат записью без провайдера — статусы, метрики, гонка, очередь АТОЛ.
describe('возврат записью без провайдера (внешняя ККТ)', () => {
  it('QUEUED → 201, journal; оригинал и возврат NOT_REQUIRED; в metrics не считаются очередью кассы', async () => {
    const { patient, reg, admin } = await setup()
    const p = (await pay(reg.cookie, { patientId: patient.id, amount: 1000 })).json.payment
    const r = await patch(admin.cookie, p.id, 'refund')
    expect(r.status).toBe(201)
    expect(r.json.journal).toBe(true)
    expect(r.json.refund.fiscalStatus).toBe('NOT_REQUIRED')
    expect(r.json.fiscalNote).toMatch(/внешней ККТ/)
    expect(await db.payment.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status: 'CANCELED', fiscalStatus: 'NOT_REQUIRED' })
    const { collectMetrics } = await import('@/lib/metrics')
    const m = await collectMetrics()
    expect(m).toMatch(/medflow_fiscal_payments\{status="QUEUED"\} 0/)
    expect(m).not.toMatch(/NOT_REQUIRED/)
  })
  it('PENDING и ERROR → 409, возврат не создаётся; ISSUED (касса была раньше) → обычный возврат QUEUED', async () => {
    const { patient, reg, admin } = await setup()
    const p = (await pay(reg.cookie, { patientId: patient.id, amount: 1000 })).json.payment
    for (const fs of ['PENDING', 'ERROR']) {
      await db.payment.update({ where: { id: p.id }, data: { fiscalStatus: fs } })
      const r = await patch(admin.cookie, p.id, 'refund')
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('NOT_FISCALIZED')
    }
    expect(await db.payment.count({ where: { type: 'REFUND' } })).toBe(0)
    await db.payment.update({ where: { id: p.id }, data: { fiscalStatus: 'ISSUED', fiscalNumber: 'ФН-ТЕСТ' } })
    const ok = await patch(admin.cookie, p.id, 'refund')
    expect(ok.status).toBe(201)
    expect(ok.json.journal).toBe(false)
    expect(ok.json.refund.fiscalStatus).toBe('QUEUED')
  })
  it('гонка: статус сменился на PENDING после чтения → updateMany с ожидаемым QUEUED не проходит, 409, возврата нет', async () => {
    const { patient, reg, admin } = await setup()
    const p = (await pay(reg.cookie, { patientId: patient.id, amount: 1000 })).json.payment
    const stale = await db.payment.findUniqueOrThrow({ where: { id: p.id }, include: { refunds: true } })
    await db.payment.update({ where: { id: p.id }, data: { fiscalStatus: 'PENDING' } }) // чек ушёл в кассу параллельно
    const { db: appDb } = await import('@/lib/db')
    vi.spyOn(appDb.payment, 'findUnique').mockResolvedValueOnce(stale as never)
    const r = await patch(admin.cookie, p.id, 'refund')
    expect(r.status).toBe(409)
    expect(await db.payment.count({ where: { type: 'REFUND' } })).toBe(0)
    expect(await db.payment.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status: 'PAID', fiscalStatus: 'PENDING' })
  })
  it('после подключения АТОЛ возврат записью не уходит как sell_refund; REFUND к непробитой продаже — тоже нет', async () => {
    const { patient, reg, admin } = await setup()
    const p = (await pay(reg.cookie, { patientId: patient.id, amount: 1000 })).json.payment
    const r = await patch(admin.cookie, p.id, 'refund')
    expect(r.status).toBe(201)
    productionEnv(ATOL_CONNECTED)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const f = await patch(admin.cookie, r.json.refund.id, 'fiscalize')
    expect(f.status).toBe(409)
    // вручную созданный QUEUED-возврат к непробитой (QUEUED) продаже
    const p2 = (await pay(reg.cookie, { patientId: patient.id, amount: 700 })).json.payment
    const bad = await db.payment.create({ data: { patientId: patient.id, amount: -700, method: 'CASH', type: 'REFUND', status: 'PAID', fiscalStatus: 'QUEUED', refundOfId: p2.id } })
    const f2 = await patch(admin.cookie, bad.id, 'fiscalize')
    expect(f2.status).toBe(409)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await db.payment.findUniqueOrThrow({ where: { id: r.json.refund.id } })).fiscalStatus).toBe('NOT_REQUIRED')
    expect((await db.payment.findUniqueOrThrow({ where: { id: bad.id } })).fiscalStatus).toBe('QUEUED')
  })
})
