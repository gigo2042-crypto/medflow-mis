// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// TOTP (RFC 6238, HMAC-SHA1, 30 с, 6 цифр) — совместим с Google Authenticator,
// Яндекс Ключом, FreeOTP и др. Без внешних зависимостей.
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error('Некорректный base32')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', key).update(buf).digest()
  const off = h[h.length - 1] & 0xf
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 1_000_000).padStart(6, '0')
}

export function totp(secret: string, timeMs: number = Date.now(), stepSec = 30): string {
  return hotp(secret, Math.floor(timeMs / 1000 / stepSec))
}

/** Проверка кода с окном ±window шагов (дрейф часов телефона). */
export function verifyTotp(secret: string, code: string, timeMs: number = Date.now(), window = 1): boolean {
  const c = String(code || '').replace(/\s+/g, '')
  if (!/^\d{6}$/.test(c)) return false
  const step = Math.floor(timeMs / 1000 / 30)
  for (let w = -window; w <= window; w++) {
    const expected = hotp(secret, step + w)
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true
  }
  return false
}

export function otpauthUri(secret: string, account: string, issuer = 'MedFlow'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
