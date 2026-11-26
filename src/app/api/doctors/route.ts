// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePerm } from '@/lib/auth-server'

export const dynamic = 'force-dynamic'

// Список врачей и их рабочих окон
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'schedule.read')
  if (!g.ok) return g.res
  try {
    const doctors = await db.doctor.findMany({ orderBy: { name: 'asc' } })
    return NextResponse.json({ doctors })
  } catch (e) {
    console.error('[doctors GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить врачей' }, { status: 500 })
  }
}
