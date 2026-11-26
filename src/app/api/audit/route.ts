// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePerm } from '@/lib/auth-server'

export const dynamic = 'force-dynamic'

export interface AuditDTO {
  id: string
  action: string
  userName: string | null
  meta: string | null
  createdAt: string
}

// Append-only журнал аудита (ФТ-039, ОТЧ-31) — только чтение, удаление запрещено
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'audit.read')
  if (!g.ok) return g.res
  try {
    const take = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get('take')) || 40))
    const rows = await db.auditLog.findMany({
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    })
    const entries: AuditDTO[] = rows.map((r) => ({
      id: r.id,
      action: r.action,
      userName: r.user?.name || null,
      meta: r.meta,
      createdAt: r.createdAt.toISOString(),
    }))
    return NextResponse.json({ entries })
  } catch (e) {
    console.error('[audit GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить журнал аудита' }, { status: 500 })
  }
}
