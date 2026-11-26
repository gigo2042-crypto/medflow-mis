// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, randomInt } from 'crypto'
import { db } from '@/lib/db'
import { audit, createAuthSession, setSessionCookie, verifyPassword } from '@/lib/auth-server'
import { hit, isLocked, resetLimit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/request-ip'
import { isDemo } from '@/lib/config'
import { twoFaRoles } from '@/lib/auth/twofa-policy'
import { toMe } from '@/lib/auth/me'

export const dynamic = 'force-dynamic'

// Лимиты входа в БД (РД-018, чек-лист Тони P1):
//  • логин+IP — 5 неудач за 15 мин: подбор с одного адреса блокируется, а злоумышленник
//    не может заблокировать сотрудника, вводя неверный пароль с другого адреса;
//  • IP — 30 неудач (перебор логинов с одного адреса);
//  • логин глобально — 100 неудач (распределённый подбор с многих адресов).
// Снять блокировку: npm run cli -- unlock --login <логин> [--ip <адрес>]
const LOGIN_LIMIT = 5
const IP_LIMIT = 30
const ACCOUNT_LIMIT = 100
const WINDOW_MS = 15 * 60_000
const LOCK_MS = 15 * 60_000
const CHALLENGE_TTL_MS = 5 * 60_000

// Вход по логину и паролю (РД-017). Второй фактор: TOTP (production),
// в демо-режиме — одноразовый код, показываемый на экране.
export async function POST(req: NextRequest) {
  try {
    const { login, password } = await req.json()
    const key = String(login || '').trim().toLowerCase()
    if (!key || !password) {
      return NextResponse.json({ error: 'Введите логин и пароль' }, { status: 400 })
    }
    const ip = clientIp(req)
    const userKey = `login:user:${key}|${ip}`
    const ipKey = `login:ip:${ip}`
    const acctKey = `login:acct:${key}`
    for (const k of [userKey, ipKey, acctKey]) {
      const l = await isLocked(k)
      if (!l.allowed) {
        return NextResponse.json(
          { error: `Слишком много неудачных попыток. Повторите через ${Math.ceil(l.retryAfterSec / 60)} мин.` },
          { status: 429 }
        )
      }
    }

    const user = await db.staffUser.findUnique({ where: { login: key } })
    if (!user || !user.active || !(await verifyPassword(String(password), user.passwordHash))) {
      await hit(userKey, LOGIN_LIMIT, WINDOW_MS, LOCK_MS)
      await hit(ipKey, IP_LIMIT, WINDOW_MS, LOCK_MS)
      await hit(acctKey, ACCOUNT_LIMIT, WINDOW_MS, LOCK_MS)
      await audit('auth.login_failed', user?.id ?? null, { login: key, ip })
      return NextResponse.json({ error: 'Неверный логин или пароль' }, { status: 401 })
    }
    await resetLimit(userKey)

    const needs2fa = user.totpEnabled || twoFaRoles().includes(user.role)
    if (needs2fa) {
      if (!user.totpEnabled && !isDemo()) {
        // В production роль обязана иметь TOTP: без него вход запрещён
        await audit('auth.2fa_not_configured', user.id, { login: user.login })
        return NextResponse.json(
          { error: 'Для вашей роли обязательна двухфакторная аутентификация. Попросите администратора выдать TOTP (npm run cli -- totp-reset).' },
          { status: 403 }
        )
      }
      const challengeId = randomBytes(24).toString('base64url')
      // демо без TOTP: одноразовый код на экране; с TOTP — код из приложения
      const demoCode = !user.totpEnabled && isDemo() ? String(randomInt(100000, 1000000)) : null
      await db.pendingLogin.deleteMany({ where: { userId: user.id } })
      await db.pendingLogin.create({
        data: { id: challengeId, userId: user.id, code: demoCode, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
      })
      await audit('auth.2fa_challenge', user.id, { login: user.login, method: user.totpEnabled ? 'TOTP' : 'DEMO' })
      const body: Record<string, unknown> = { pending2fa: true, challengeId, method: user.totpEnabled ? 'TOTP' : 'DEMO' }
      if (demoCode && isDemo()) body.demoCode = demoCode
      return NextResponse.json(body)
    }

    const token = await createAuthSession(user.id)
    await audit('auth.login', user.id, { login: user.login, role: user.role })
    const res = NextResponse.json({ me: toMe(user) })
    return setSessionCookie(res, token)
  } catch (e) {
    console.error('[auth/login POST]', e)
    return NextResponse.json({ error: 'Не удалось выполнить вход' }, { status: 500 })
  }
}
