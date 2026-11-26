// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, clearSessionCookie, getSessionUser } from '@/lib/auth-server'

export const dynamic = 'force-dynamic'

// Выход: удаляется только текущая сессия (другие устройства сотрудника остаются)
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(req)
    if (user) {
      await db.authSession.deleteMany({ where: { id: user.sessionId } })
      const left = await db.authSession.count({ where: { userId: user.id } })
      if (left === 0) {
        await db.workSession.updateMany({
          where: { userId: user.id, status: 'ACTIVE' },
          data: { status: 'RELEASED', releaseBy: 'USER' },
        })
      }
      await audit('auth.logout', user.id, { login: user.login })
    }
    return clearSessionCookie(NextResponse.json({ ok: true }))
  } catch (e) {
    console.error('[auth/logout POST]', e)
    return clearSessionCookie(NextResponse.json({ ok: true }))
  }
}
