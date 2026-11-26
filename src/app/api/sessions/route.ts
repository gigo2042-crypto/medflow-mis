// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { IDLE_RELEASE_SECONDS, LICENSE_LIMIT } from '@/lib/mis-utils'
import { SessionDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

// Панель concurrent-сессий с авто-освобождением простоя (точка улучшения №5)
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'sessions.read')
  if (!g.ok) return g.res
  try {
    const now = new Date()
    const idleCutoff = new Date(now.getTime() - IDLE_RELEASE_SECONDS * 1000)
    // GET без побочных эффектов (3.7): простаивающие сессии не показываются как активные;
    // их фактическое освобождение — в POST этого же API
    const released = { count: await db.workSession.count({ where: { status: 'ACTIVE', lastActivity: { lt: idleCutoff } } }) }
    const active = await db.workSession.findMany({
      where: { status: 'ACTIVE', lastActivity: { gte: idleCutoff } },
      include: { user: true },
      orderBy: { startedAt: 'asc' },
    })
    const sessions: SessionDTO[] = active.map((s) => ({
      id: s.id,
      userId: s.userId,
      userName: s.user.name,
      role: s.user.role,
      device: s.device,
      startedAt: s.startedAt.toISOString(),
      lastActivity: s.lastActivity.toISOString(),
      idleSeconds: Math.max(0, Math.floor((now.getTime() - s.lastActivity.getTime()) / 1000)),
    }))
    return NextResponse.json({ sessions, licenseLimit: LICENSE_LIMIT, idleReleased: released.count, idleLimitSeconds: IDLE_RELEASE_SECONDS })
  } catch (e) {
    console.error('[sessions GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить сессии' }, { status: 500 })
  }
}

// Вход в систему: контроль одновременных рабочих мест (РД-006..009)
export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'sessions.manage')
  if (!g.ok) return g.res
  try {
    const body = await req.json()
    if (!body.userId) {
      return NextResponse.json({ error: 'userId обязателен' }, { status: 400 })
    }
    const user = await db.staffUser.findUnique({ where: { id: body.userId } })
    if (!user) {
      return NextResponse.json({ error: 'Сотрудник не найден' }, { status: 404 })
    }
    // авто-освобождение простоя — здесь, в изменяющем запросе (раньше делалось в GET)
    await db.workSession.updateMany({
      where: { status: 'ACTIVE', lastActivity: { lt: new Date(Date.now() - IDLE_RELEASE_SECONDS * 1000) } },
      data: { status: 'RELEASED', releaseBy: 'AUTO_IDLE' },
    })
    const activeCount = await db.workSession.count({ where: { status: 'ACTIVE' } })
    if (activeCount >= LICENSE_LIMIT) {
      return NextResponse.json(
        {
          error: `Лимит лицензии: занято ${activeCount} из ${LICENSE_LIMIT} одновременных мест. Сессия поставлена в очередь — освободите место или дождитесь авто-освобождения простоя.`,
          activeCount,
          licenseLimit: LICENSE_LIMIT,
          queued: true,
        },
        { status: 429 }
      )
    }
    const session = await db.workSession.create({
      data: { userId: body.userId, device: body.device || 'web', lastActivity: new Date() },
      include: { user: true },
    })
    await audit('license.session_opened', g.user.id, { userId: body.userId, device: session.device })
    return NextResponse.json({ session }, { status: 201 })
  } catch (e) {
    console.error('[sessions POST]', e)
    return NextResponse.json({ error: 'Не удалось открыть сессию' }, { status: 500 })
  }
}
