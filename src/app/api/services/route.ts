// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'

export const dynamic = 'force-dynamic'

// Прайс-лист (ФТ-007): дерево услуг по категориям
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'cash.read')
  if (!g.ok) return g.res
  try {
    const services = await db.serviceItem.findMany({
      where: { active: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    })
    return NextResponse.json({ services })
  } catch (e) {
    console.error('[services GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить прайс-лист' }, { status: 500 })
  }
}

// Новая услуга — только управление прейскурантом (price.manage, ADMIN)
export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'price.manage')
  if (!g.ok) return g.res
  try {
    const { name, category, price, durationMinutes } = await req.json()
    if (!name || typeof price !== 'number' || price <= 0) {
      return NextResponse.json({ error: 'Укажите название и цену услуги' }, { status: 400 })
    }
    const service = await db.serviceItem.create({
      data: {
        name: String(name).trim(),
        category: (category || 'Услуги').trim(),
        price: Math.round(price),
        durationMinutes: Number(durationMinutes) > 0 ? Math.round(Number(durationMinutes)) : 30,
      },
    })
    await audit('price.created', g.user.id, { serviceId: service.id, name: service.name, price: service.price })
    return NextResponse.json({ service }, { status: 201 })
  } catch (e) {
    console.error('[services POST]', e)
    return NextResponse.json({ error: 'Не удалось создать услугу' }, { status: 500 })
  }
}
