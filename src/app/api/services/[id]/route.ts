// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'

export const dynamic = 'force-dynamic'

// Изменение цены/архивирование услуги — версионность цены отражается в аудите (ФТ-007)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requirePerm(req, 'price.manage')
  if (!g.ok) return g.res
  try {
    const { id } = await params
    const { name, category, price, active } = await req.json()
    const existing = await db.serviceItem.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Услуга не найдена' }, { status: 404 })
    }
    const service = await db.serviceItem.update({
      where: { id },
      data: {
        name: name !== undefined ? String(name).trim() : undefined,
        category: category !== undefined ? String(category).trim() : undefined,
        price: typeof price === 'number' && price > 0 ? Math.round(price) : undefined,
        active: typeof active === 'boolean' ? active : undefined,
      },
    })
    if (price !== undefined && price !== existing.price) {
      await audit('price.updated', g.user.id, { serviceId: id, name: service.name, oldPrice: existing.price, newPrice: service.price })
    } else {
      await audit('price.updated', g.user.id, { serviceId: id, name: service.name })
    }
    return NextResponse.json({ service })
  } catch (e) {
    console.error('[services PATCH]', e)
    return NextResponse.json({ error: 'Не удалось изменить услугу' }, { status: 500 })
  }
}
