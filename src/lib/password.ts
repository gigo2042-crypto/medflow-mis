// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Пароли сотрудников: scrypt со случайной солью. Без зависимостей от Next — используется и в CLI.
// Асинхронный scrypt (пул libuv) с ограничением параллелизма: вход не блокирует event loop,
// а волна запросов не выедает всю память/CPU (чек-лист Тони, P1).
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto'
import { promisify } from 'util'

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>
const MAX_PARALLEL = Math.max(1, Number(process.env.SCRYPT_MAX_PARALLEL || 4) || 4)
let active = 0
const waiters: Array<() => void> = []

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiters.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiters.shift()?.()
  }
}

const derive = (password: string, salt: string) => limited(() => scrypt(password, salt, 32))

// Пароли: scrypt со случайной солью (РД-017)
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const hash = (await derive(password, salt)).toString('hex')
  return `${salt}:${hash}`
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored || !stored.includes(':')) {
    // выравнивание времени ответа для несуществующих пользователей
    await derive(password || 'x', 'medflow-timing-pad')
    return false
  }
  const [salt, hash] = stored.split(':')
  const candidate = await derive(password, salt)
  const expected = Buffer.from(hash, 'hex')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

/** Минимальные требования к паролю сотрудника. */
export function passwordProblem(password: string): string | null {
  if (!password || password.length < 12) return 'Пароль не короче 12 символов'
  if (!/[a-zа-я]/i.test(password) || !/\d/.test(password)) return 'Пароль должен содержать буквы и цифры'
  return null
}
