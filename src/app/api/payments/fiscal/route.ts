// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { actorId, actorMeta, audit, requireServiceOrPerm } from '@/lib/auth-server'
import { pollFiscal } from '@/lib/fiscal-queue'

export const dynamic = 'force-dynamic'

// Опрос облачной кассы по отправленным чекам (планировщик раз в минуту или кассир вручную)
export async function POST(req: NextRequest) {
  const g = await requireServiceOrPerm(req, 'cash.fiscalize')
  if (!g.ok) return g.res
  try {
    const res = await pollFiscal()
    if (res.checked > 0) await audit('fiscal.poll', actorId(g), { ...res, ...actorMeta(g) })
    return NextResponse.json(res)
  } catch (e) {
    console.error('[payments/fiscal]', e)
    return NextResponse.json({ error: 'Не удалось опросить кассу' }, { status: 500 })
  }
}
