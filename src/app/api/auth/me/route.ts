// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth-server'
import { toMe } from '@/lib/auth/me'

export const dynamic = 'force-dynamic'

// Текущий пользователь и его права — для восстановления сессии при загрузке страницы
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) {
    return NextResponse.json({ error: 'Требуется вход в систему' }, { status: 401 })
  }
  const u = await db.staffUser.findUnique({ where: { id: user.id } })
  return NextResponse.json({ me: toMe(u ?? user) })
}
