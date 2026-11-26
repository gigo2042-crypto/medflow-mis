// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Регрессия: реквизиты клиники только из env; фискализация АТОЛ Онлайн v5 — формат запроса по описанию протокола.
// Живой АТОЛ не вызывается: fetch подменяется моком. Все данные фейковые.
import { beforeEach, describe, expect, it } from 'vitest'
import { clinicRequisitesFrom } from '../../scripts/env-rules.mjs'
import { _resetTokenCache, applyDiscount, atolTimestamp, buildAtolReceipt, fetchReport, fiscalStatus, sendReceipt } from '@/lib/fiscal'

const ATOL_ENV = {
  APP_MODE: 'production',
  FISCAL_PROVIDER: 'atol',
  ATOL_LOGIN: 'fake-login',
  ATOL_PASSWORD: 'fake-pass',
  ATOL_GROUP_CODE: 'fake-group',
  ATOL_SNO: 'usn_income',
  ATOL_PAYMENT_ADDRESS: 'https://clinic.example',
  ATOL_COMPANY_EMAIL: 'kassa@clinic.example',
  ATOL_BASE_URL: 'https://atol.mock/possystem/v5',
  CLINIC_INN: '7700000000',
  CLINIC_NAME: 'ООО «Тестовая клиника»',
  CLINIC_ADDRESS: 'г. Тест, ул. Тестовая, 1',
  CLINIC_LICENSE: 'ТЕСТ-0001',
}

function setEnv(vars: Record<string, string | undefined>) {
  for (const k of [...Object.keys(ATOL_ENV), 'ATOL_VAT', 'CLINIC_SHORT_NAME']) delete process.env[k]
  Object.assign(process.env, vars)
}

describe('Реквизиты клиники', () => {
  it('production без CLINIC_* — не настроено, ничего не выдумывается', () => {
    const c = clinicRequisitesFrom({ APP_MODE: 'production' })
    expect(c.configured).toBe(false)
    expect(c.missing).toEqual(['CLINIC_NAME', 'CLINIC_INN', 'CLINIC_ADDRESS', 'CLINIC_LICENSE'])
    expect(c.name).toBe('')
    expect(JSON.stringify(c)).not.toContain('МедФлоу')
  })
  it('demo — явно помеченные демо-значения', () => {
    const c = clinicRequisitesFrom({ APP_MODE: 'demo' })
    expect(c.configured).toBe(true)
    expect(c.demo).toBe(true)
    expect(c.name).toContain('ДЕМО')
  })
  it('production с env — значения из env', () => {
    const c = clinicRequisitesFrom(ATOL_ENV)
    expect(c.configured).toBe(true)
    expect(c.inn).toBe('7700000000')
  })
})

describe('Фискализация АТОЛ Онлайн v5', () => {
  beforeEach(() => {
    setEnv(ATOL_ENV)
    _resetTokenCache()
  })

  it('без FISCAL_PROVIDER — явная проблема, а не тихий 501', () => {
    setEnv({ APP_MODE: 'production' })
    const st = fiscalStatus()
    expect(st.configured).toBe(false)
    expect(st.problem).toMatch(/не подключена/)
  })

  it('неполные настройки АТОЛ перечисляются', () => {
    setEnv({ APP_MODE: 'production', FISCAL_PROVIDER: 'atol', ATOL_LOGIN: 'x' })
    expect(fiscalStatus().problem).toMatch(/ATOL_PASSWORD/)
  })

  it('timestamp в формате дд.мм.гггг чч:мм:сс', () => {
    expect(atolTimestamp(new Date('2026-11-25T09:05:07Z'), 'Europe/Moscow')).toBe('25.11.2026 12:05:07')
  })

  it('скидка распределяется так, что price × quantity = sum и итог = сумма − скидка', () => {
    const lines = applyDiscount([{ name: 'Приём', price: 1500, qty: 1 }, { name: 'Анализ', price: 333.33, qty: 3 }], 100)
    for (const l of lines) expect(Math.round(l.price * l.quantity * 100)).toBe(Math.round(l.sum * 100))
    const total = lines.reduce((s, l) => s + l.sum, 0)
    expect(Math.round(total * 100)).toBe(Math.round((1500 + 999.99 - 100) * 100))
  })

  it('чек: обязательные поля протокола, услуга (payment_object 4), безнал = 1, клиент по телефону', () => {
    const doc = buildAtolReceipt({ externalId: 'pay-1', operation: 'sell', items: [{ name: 'Консультация', price: 2000, qty: 1 }], discount: 0, method: 'CARD', client: { phone: '8 (900) 000-00-01' } })
    expect(doc.external_id).toBe('pay-1')
    expect(doc.receipt.client).toEqual({ phone: '+79000000001' })
    expect(doc.receipt.company).toEqual({ email: 'kassa@clinic.example', sno: 'usn_income', inn: '7700000000', payment_address: 'https://clinic.example' })
    expect(doc.receipt.items[0]).toMatchObject({ payment_method: 'full_payment', payment_object: 4, measure: 0, vat: { type: 'none' }, sum: 2000 })
    expect(doc.receipt.payments).toEqual([{ type: 1, sum: 2000 }])
    expect(doc.receipt.total).toBe(2000)
  })

  it('без e-mail и телефона чек не формируется', () => {
    expect(() => buildAtolReceipt({ externalId: 'x', operation: 'sell', items: [{ name: 'a', price: 1, qty: 1 }], discount: 0, method: 'CASH', client: {} })).toThrow(/e-mail или телефон/)
  })

  it('getToken → sell → report (мок): токен в заголовке Token, повтор при ExpiredToken', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    let tokenN = 0
    let first = true
    const mock = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/getToken')) return new Response(JSON.stringify({ error: null, token: `tok-${++tokenN}` }))
      if (url.endsWith('/fake-group/sell')) {
        if (first) {
          first = false
          return new Response(JSON.stringify({ error: { code: 11, text: 'ExpiredToken' } }), { status: 401 })
        }
        return new Response(JSON.stringify({ uuid: 'uuid-1', status: 'wait', error: null }))
      }
      if (url.includes('/fake-group/report/uuid-1')) {
        return new Response(JSON.stringify({ uuid: 'uuid-1', status: 'done', payload: { fn_number: '9999000000000001', fiscal_document_number: 42, fiscal_document_attribute: 123456, ofd_receipt_url: 'https://ofd.mock/r/1' } }))
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    const r = await sendReceipt({ externalId: 'pay-2', operation: 'sell', items: [{ name: 'Приём', price: 1000, qty: 1 }], discount: 0, method: 'CASH', client: { email: 'p@example.test' } }, mock)
    expect(r).toEqual({ state: 'PENDING', uuid: 'uuid-1', error: null })
    const sells = calls.filter((c) => c.url.endsWith('/sell'))
    expect(sells).toHaveLength(2)
    expect((sells[1].init.headers as Record<string, string>).Token).toBe('tok-2')
    const body = JSON.parse(String(sells[1].init.body))
    expect(body.receipt.payments[0].type).toBe(0) // наличные
    const rep = await fetchReport('uuid-1', mock)
    expect(rep.state).toBe('ISSUED')
    expect(rep.fiscalNumber).toContain('ФД 42')
  })

  it('повтор external_id (code 33) без uuid — ошибка без второго чека', async () => {
    const mock = (async (url: string) => {
      if (url.endsWith('/getToken')) return new Response(JSON.stringify({ token: 't' }))
      return new Response(JSON.stringify({ error: { code: 33, text: 'exists' }, status: 'fail' }), { status: 400 })
    }) as unknown as typeof fetch
    const r = await sendReceipt({ externalId: 'dup', operation: 'sell_refund', items: [{ name: 'a', price: 1, qty: 1 }], discount: 0, method: 'CARD', client: { email: 'a@b.c' } }, mock)
    expect(r.state).toBe('ERROR')
    expect(r.error).toMatch(/уже зарегистрирован/)
  })
})

describe('Аудит планировщика', () => {
  it('пустой прогон не пишет аудит, прогон с работой — пишет', async () => {
    const { hadWork } = await import('@/lib/audit-utils')
    expect(hadWork({ sent: 0, failed: 0 }, 0, 0)).toBe(false)
    expect(hadWork({ sent: 0, failed: 1 }, 0)).toBe(true)
    expect(hadWork({ delivery: { sent: 0, retrying: 2 } })).toBe(true)
  })
})

describe('График врача', () => {
  it('выходные по графику, праздник клиники, отпуск врача и особые часы', async () => {
    const { hoursOn, slotError, weekdayOf } = await import('@/lib/appointment-rules')
    const doc = { id: 'd1', workStart: '09:00', workEnd: '18:00', slotMinutes: 30, workDays: '1111100' }
    expect(weekdayOf('2030-01-05')).toBe(5) // суббота
    expect(hoursOn(doc, '2030-01-05')).toMatchObject({ off: true })
    expect(hoursOn(doc, '2030-01-07')).toMatchObject({ off: false, workStart: '09:00' })
    const ex = [
      { doctorId: null, date: '2030-01-08', kind: 'OFF', workStart: null, workEnd: null, reason: 'Праздник' },
      { doctorId: 'd1', date: '2030-01-09', kind: 'HOURS', workStart: '12:00', workEnd: '14:00', reason: null },
      { doctorId: 'd2', date: '2030-01-10', kind: 'OFF', workStart: null, workEnd: null, reason: 'Отпуск' },
    ]
    expect(hoursOn(doc, '2030-01-08', ex)).toEqual({ off: true, reason: 'Праздник' })
    expect(hoursOn(doc, '2030-01-09', ex)).toEqual({ off: false, workStart: '12:00', workEnd: '14:00' })
    expect(hoursOn(doc, '2030-01-10', ex)).toMatchObject({ off: false }) // отпуск другого врача
    const now = Date.UTC(2029, 0, 1)
    // суббота 10:00 МСК = 07:00 UTC
    expect(slotError(doc, new Date(Date.UTC(2030, 0, 5, 7, 0)), now)).toMatch(/Нерабочий день/)
    expect(slotError(doc, new Date(Date.UTC(2030, 0, 7, 7, 0)), now)).toBeNull()
    expect(slotError(doc, new Date(Date.UTC(2030, 0, 9, 7, 0)), now, ex)).toMatch(/вне рабочего времени/)
    expect(slotError(doc, new Date(Date.UTC(2030, 0, 9, 9, 0)), now, ex)).toBeNull()
  })
})
