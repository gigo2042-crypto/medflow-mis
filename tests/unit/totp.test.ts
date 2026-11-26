// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, totp, verifyTotp } from '@/lib/totp'

describe('TOTP (RFC 6238)', () => {
  // Тестовый вектор RFC 6238: секрет "12345678901234567890", T=59 → 94287082 (8 цифр) → 287082 (6 цифр)
  const secret = base32Encode(Buffer.from('12345678901234567890'))
  it('RFC-вектор', () => {
    expect(totp(secret, 59_000)).toBe('287082')
    expect(hotp(secret, 1)).toBe('287082')
  })
  it('base32 туда-обратно', () => {
    expect(base32Decode(base32Encode(Buffer.from('hello world'))).toString()).toBe('hello world')
  })
  it('проверка кода с окном ±1 шаг', () => {
    const s = generateTotpSecret()
    const t = 1_700_000_000_000
    expect(verifyTotp(s, totp(s, t), t)).toBe(true)
    expect(verifyTotp(s, totp(s, t - 30_000), t)).toBe(true)
    expect(verifyTotp(s, totp(s, t - 120_000), t)).toBe(false)
    expect(verifyTotp(s, '12345', t)).toBe(false)
    expect(verifyTotp(s, 'abcdef', t)).toBe(false)
  })
  it('otpauth URI', () => {
    expect(otpauthUri('ABC', 'admin', 'MedFlow')).toMatch(/^otpauth:\/\/totp\/MedFlow/)
  })
})
