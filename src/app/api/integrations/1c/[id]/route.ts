// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePerm } from '@/lib/auth-server'

export const dynamic = 'force-dynamic'

// Скачивание/просмотр пакета выгрузки в 1С (ИНТ-006):
// ?download=1 — файл CommerceML-XML (Content-Disposition),
// по умолчанию — JSON с текстом XML для предпросмотра.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // Пакет содержит складские и финансовые данные — только с правом integrations.read (чеклист п.1)
  const g = await requirePerm(req, 'integrations.read')
  if (!g.ok) return g.res
  try {
    const { id } = await ctx.params
    const ex = await db.oneCExport.findUnique({ where: { id } })
    if (!ex) return NextResponse.json({ error: 'Пакет не найден' }, { status: 404 })

    if (req.nextUrl.searchParams.get('download')) {
      const filename = `1c-${ex.scope.toLowerCase()}-${id.slice(-6)}.xml`
      return new NextResponse(ex.xml, {
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      })
    }

    return NextResponse.json({
      id: ex.id,
      scope: ex.scope,
      status: ex.status,
      size: ex.size,
      xml: ex.xml,
    })
  } catch (e) {
    console.error('[integrations/1c/[id] GET]', e)
    return NextResponse.json({ error: 'Не удалось получить пакет' }, { status: 500 })
  }
}
