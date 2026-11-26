// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { offerFreedSlot } from '@/lib/waiting'

export const dynamic = 'force-dynamic'

// Пациент отказался от предложенного слота (ФТ-004/ТУ-004):
// заявка закрывается, слот каскадно предлагается следующему в очереди
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requirePerm(req, 'waitinglist.manage')
  if (!g.ok) return g.res
  try {
    const { id } = await params
    const entry = await db.waitingListEntry.findUnique({ where: { id } })
    if (!entry) return NextResponse.json({ error: 'Заявка не найдена' }, { status: 404 })
    if (entry.status !== 'OFFERED') {
      return NextResponse.json({ error: 'Отказ фиксируется только по предложенному слоту' }, { status: 400 })
    }
    await db.waitingListEntry.update({ where: { id }, data: { status: 'DECLINED' } })
    let offeredTo: string | null = null
    if (entry.offeredDoctorId && entry.offeredSlot && entry.offeredSlot.getTime() > Date.now()) {
      const offer = await offerFreedSlot(entry.offeredDoctorId, entry.offeredSlot)
      offeredTo = offer?.patientName ?? null
    }
    await audit('waiting.declined', g.user.id, { entryId: id, nextOfferedTo: offeredTo })
    return NextResponse.json({ ok: true, offeredTo })
  } catch (e) {
    console.error('[waiting-list decline]', e)
    return NextResponse.json({ error: 'Не удалось зафиксировать отказ' }, { status: 500 })
  }
}
