// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { describe, expect, it } from 'vitest'
import { buildReceipt, receiptItemLines, RECEIPT_WIDTH, wrapText } from '@/lib/receipt'

describe('Чек', () => {
  it('длинные названия переносятся, строки не шире ленты', () => {
    const lines = receiptItemLines('Профессиональная гигиена полости рта с покрытием фторлаком и полировкой', 1, 4500)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(RECEIPT_WIDTH)
    expect(wrapText('a b c', 3)).toEqual(['a b', 'c'])
  })
  it('скидка — отдельной строкой, итог = сумма − скидка', () => {
    const r = buildReceipt(
      { fiscalNumber: null, patientName: 'Тест Т.', cardNumber: 'MF-1', items: [{ name: 'Приём', qty: 1, price: 3000 }], amount: 2700, discount: 300, method: 'CARD', type: 'PAYMENT', createdByName: 'Кассир' } as never,
      { demo: false, clinicName: 'Клиника', dateLine: '01.01.2026', methodLabel: 'Карта' }
    )
    expect(r).toMatch(/Скидка\s+-300/)
    expect(r).toContain('ИТОГ: 2700')
    expect(r).not.toContain('ДЕМО')
  })
  it('демо-чек помечен как нефискальный', () => {
    const r = buildReceipt(
      { fiscalNumber: null, patientName: 'Т', cardNumber: 'MF-1', items: [], amount: 100, discount: 0, method: 'CASH', type: 'PAYMENT', createdByName: null } as never,
      { demo: true, clinicName: 'К', dateLine: '-', methodLabel: 'Нал' }
    )
    expect(r).toContain('ДЕМО')
  })
})
