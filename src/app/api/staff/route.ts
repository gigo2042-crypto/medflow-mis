// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePerm } from '@/lib/auth-server'

export const dynamic = 'force-dynamic'

// Сотрудники клиники — виден состав и роли (панель лицензий)
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'sessions.read')
  if (!g.ok) return g.res
  try {
    const users = await db.staffUser.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, role: true, login: true, active: true },
    })
    return NextResponse.json({ users })
  } catch (e) {
    console.error('[staff GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить сотрудников' }, { status: 500 })
  }
}
