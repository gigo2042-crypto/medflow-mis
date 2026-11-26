// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePerm } from '@/lib/auth-server'
import { ProtocolTemplateDTO, TemplateSection } from '@/lib/types'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'visits.read')
  if (!g.ok) return g.res
  try {
    const rows = await db.protocolTemplate.findMany({ orderBy: { name: 'asc' } })
    const templates: ProtocolTemplateDTO[] = rows.map((t) => {
      let sections: TemplateSection[] = []
      try {
        const parsed: unknown = JSON.parse(t.schemaJson)
        if (Array.isArray(parsed)) {
          sections = parsed as TemplateSection[]
        } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { sections?: unknown }).sections)) {
          sections = (parsed as { sections: TemplateSection[] }).sections
        }
      } catch {
        sections = []
      }
      return { id: t.id, name: t.name, specialty: t.specialty, type: t.type, sections }
    })
    return NextResponse.json({ templates })
  } catch (e) {
    console.error('[templates GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить шаблоны' }, { status: 500 })
  }
}
