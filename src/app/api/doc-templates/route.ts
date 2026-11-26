// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePerm } from '@/lib/auth-server'

export const dynamic = 'force-dynamic'

// Каталог печатных форм клиники (ФТ-009): договор, согласия, справки
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'docs.read')
  if (!g.ok) return g.res
  try {
    const templates = await db.documentTemplate.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, kind: true },
    })
    return NextResponse.json({ templates })
  } catch (e) {
    console.error('[doc-templates GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить шаблоны документов' }, { status: 500 })
  }
}
