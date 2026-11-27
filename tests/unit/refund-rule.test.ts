// Возврат: когда нужен пробитый чек прихода (54-ФЗ). Только чистая логика, без БД.
import { describe, expect, it } from 'vitest'
import { refundRequiresIssuedReceipt } from '@/lib/cash'

describe('возврат и фискальный провайдер', () => {
  it('с подключённой кассой и в демо — только к пробитому чеку', () => {
    expect(refundRequiresIssuedReceipt(true, false)).toBe(true)
    expect(refundRequiresIssuedReceipt(true, true)).toBe(true)
    expect(refundRequiresIssuedReceipt(false, true)).toBe(true)
  })
  it('без провайдера (внешняя ККТ, статусы не отслеживаются) возврат оформляется записью', () => {
    expect(refundRequiresIssuedReceipt(false, false)).toBe(false)
  })
})

// Ревью ocr (находки 4–6): план возврата и текст для кассира. Только чистая логика.
import { refundPlan, refundToast, FISCAL_NOT_REQUIRED } from '@/lib/refund-policy'

describe('refundPlan: допустимые статусы', () => {
  it('без провайдера (production): QUEUED → возврат записью, ожидаемый статус QUEUED (кнопка в кассе видна)', () => {
    expect(refundPlan('QUEUED', false, false)).toEqual({ ok: true, journal: true, expectFiscalStatus: 'QUEUED' })
  })
  it('без провайдера: PENDING и ERROR — отказ 409 NOT_FISCALIZED; ISSUED — обычный возврат (не запись)', () => {
    for (const s of ['PENDING', 'ERROR', 'CANCELED', 'NOT_REQUIRED', 'FAILED']) expect(refundPlan(s, false, false).ok).toBe(false)
    expect(refundPlan('ISSUED', false, false)).toEqual({ ok: true, journal: false, expectFiscalStatus: 'ISSUED' })
  })
  it('касса подключена или демо: только ISSUED, возврат записью невозможен', () => {
    for (const [cfg, demo] of [[true, false], [false, true], [true, true]] as const) {
      expect(refundPlan('ISSUED', cfg, demo)).toEqual({ ok: true, journal: false, expectFiscalStatus: 'ISSUED' })
      for (const s of ['QUEUED', 'PENDING', 'ERROR']) {
        const p = refundPlan(s, cfg, demo)
        expect(p.ok).toBe(false)
        if (!p.ok) expect(p.code).toBe('NOT_FISCALIZED')
      }
    }
  })
})

describe('refundToast: честный текст', () => {
  it('чек выдан / без чека / не пробит', () => {
    expect(refundToast(1000, 'ISSUED')).toBe('Возврат 1000 ₽ оформлен, чек возврата выдан')
    expect(refundToast(1000, FISCAL_NOT_REQUIRED)).toMatch(/без чека/)
    expect(refundToast(1000, FISCAL_NOT_REQUIRED)).not.toMatch(/выдан/)
    expect(refundToast(1000, 'QUEUED', 'Касса не настроена')).toBe('Возврат 1000 ₽ оформлен, чек возврата не пробит: Касса не настроена')
    expect(refundToast(1000, 'PENDING')).not.toMatch(/выдан/)
  })
})
