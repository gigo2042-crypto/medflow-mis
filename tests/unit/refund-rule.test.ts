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
