// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { requirePerm } from '@/lib/auth-server'
import { searchIcdDb } from '@/lib/icd-db'

export const dynamic = 'force-dynamic'

// Поиск по справочнику МКБ-10 (код или название) — для выбора диагноза врачом
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'visits.write')
  if (!g.ok) return g.res
  const q = (req.nextUrl.searchParams.get('q') || '').slice(0, 100)
  return NextResponse.json(await searchIcdDb(q, 10))
}
