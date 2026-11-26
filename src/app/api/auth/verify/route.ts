// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'
import { audit, createAuthSession, setSessionCookie } from '@/lib/auth-server'
import { verifyTotp } from '@/lib/totp'
import { hit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/request-ip'
import { toMe } from '@/lib/auth/me'

export const dynamic = 'force-dynamic'

const MAX_ATTEMPTS = 5

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// Подтверждение второго фактора (РД-015): код привязан к challenge, не более 5 попыток
export async function POST(req: NextRequest) {
  try {
    const { challengeId, code } = await req.json()
    if (!challengeId || !code) {
      return NextResponse.json({ error: 'Введите код подтверждения' }, { status: 400 })
    }
    const ipLimit = await hit(`2fa:ip:${clientIp(req)}`, 30, 15 * 60_000, 15 * 60_000)
    if (!ipLimit.allowed) return NextResponse.json({ error: 'Слишком много попыток, повторите позже' }, { status: 429 })

    // Попытка резервируется ОДНИМ SQL до проверки кода: при 50 параллельных запросах
    // на один challenge проверку проходят не больше MAX_ATTEMPTS из них (чек-лист Тони, P0).
    const nowIso = new Date().toISOString()
    const reserved = await db.$queryRaw<Array<{ attempts: number }>>`
      UPDATE "PendingLogin" SET "attempts" = "attempts" + 1
      WHERE "id" = ${String(challengeId)} AND "attempts" < ${MAX_ATTEMPTS} AND "expiresAt" > ${nowIso}::timestamp
      RETURNING "attempts"`
    if (!reserved.length) {
      const left = await db.pendingLogin.findUnique({ where: { id: String(challengeId) }, select: { attempts: true, expiresAt: true } })
      if (left && left.attempts >= MAX_ATTEMPTS && left.expiresAt.getTime() > Date.now()) {
        await db.pendingLogin.deleteMany({ where: { id: String(challengeId) } })
        return NextResponse.json({ error: 'Превышено число попыток — войдите заново' }, { status: 429 })
      }
      return NextResponse.json({ error: 'Код неверный или истёк (действителен 5 минут)' }, { status: 401 })
    }
    const attempts = reserved[0].attempts
    const pending = await db.pendingLogin.findUnique({ where: { id: String(challengeId) }, include: { user: true } })
    if (!pending) return NextResponse.json({ error: 'Код неверный или истёк (действителен 5 минут)' }, { status: 401 })
    const c = String(code).trim()
    let ok = pending.user.totpEnabled && pending.user.totpSecret
      ? verifyTotp(pending.user.totpSecret, c)
      : pending.code
        ? sameCode(pending.code, c)
        : false
    // TOTP: один и тот же код повторно не принимается (защита от повторного использования)
    if (ok && pending.user.totpEnabled) {
      await db.rateLimit.deleteMany({ where: { key: { startsWith: 'totp:used:' }, windowStart: { lt: new Date(Date.now() - 5 * 60_000) } } })
      try {
        await db.rateLimit.create({ data: { key: `totp:used:${pending.userId}:${c}`, count: 1 } })
      } catch {
        ok = false
      }
    }
    if (!ok) {
      if (attempts >= MAX_ATTEMPTS) {
        await db.pendingLogin.deleteMany({ where: { id: pending.id } })
        await audit('auth.2fa_locked', pending.userId, {})
        return NextResponse.json({ error: 'Превышено число попыток — войдите заново' }, { status: 429 })
      }
      return NextResponse.json({ error: 'Код неверный или истёк (действителен 5 минут)' }, { status: 401 })
    }
    // challenge одноразовый: сессию выдаёт только тот запрос, который его удалил
    const consumed = await db.pendingLogin.deleteMany({ where: { id: pending.id } })
    if (consumed.count !== 1) return NextResponse.json({ error: 'Код неверный или истёк (действителен 5 минут)' }, { status: 401 })
    const token = await createAuthSession(pending.user.id)
    await audit('auth.login_2fa', pending.user.id, { login: pending.user.login })
    const res = NextResponse.json({ me: toMe(pending.user) })
    return setSessionCookie(res, token)
  } catch (e) {
    console.error('[auth/verify POST]', e)
    return NextResponse.json({ error: 'Не удалось подтвердить вход' }, { status: 500 })
  }
}
