// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'

export const dynamic = 'force-dynamic'

// Имитация активности пользователя (сброс idle-таймера)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requirePerm(req, 'sessions.manage')
  if (!g.ok) return g.res
  try {
    const { id } = await params
    const session = await db.workSession.update({
      where: { id },
      data: { lastActivity: new Date() },
      include: { user: true },
    })
    return NextResponse.json({ session })
  } catch (e) {
    console.error('[sessions PATCH]', e)
    return NextResponse.json({ error: 'Сессия не найдена' }, { status: 404 })
  }
}

// Принудительное освобождение места администратором (РД-011, точка улучшения №5)
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requirePerm(req, 'sessions.manage')
  if (!g.ok) return g.res
  try {
    const { id } = await params
    const session = await db.workSession.update({
      where: { id },
      data: { status: 'RELEASED', releaseBy: 'ADMIN' },
      include: { user: true },
    })
    await audit('license.session_released', g.user.id, { sessionId: id, user: session.user.name })
    return NextResponse.json({ session })
  } catch (e) {
    console.error('[sessions DELETE]', e)
    return NextResponse.json({ error: 'Сессия не найдена' }, { status: 404 })
  }
}
