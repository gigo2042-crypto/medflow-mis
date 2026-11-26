// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { offerFreedSlot } from '@/lib/waiting'

export const dynamic = 'force-dynamic'

// Снять заявку из листа ожидания (ФТ-004)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requirePerm(req, 'waitinglist.manage')
  if (!g.ok) return g.res
  try {
    const { id } = await params
    const body = await req.json()
    if (body.action !== 'CANCEL') {
      return NextResponse.json({ error: 'Поддерживается только action=CANCEL' }, { status: 400 })
    }
    const entry = await db.waitingListEntry.findUnique({ where: { id } })
    if (!entry) return NextResponse.json({ error: 'Заявка не найдена' }, { status: 404 })
    if (!['ACTIVE', 'OFFERED'].includes(entry.status)) {
      return NextResponse.json({ error: 'Заявка уже закрыта' }, { status: 400 })
    }
    let offeredTo: string | null = null
    if (entry.status === 'OFFERED' && entry.offeredDoctorId && entry.offeredSlot) {
      // снимаем с удержания и каскадно предлагаем слот следующему в очереди
      await db.waitingListEntry.update({ where: { id }, data: { status: 'DECLINED' } })
      if (entry.offeredSlot.getTime() > Date.now()) {
        const offer = await offerFreedSlot(entry.offeredDoctorId, entry.offeredSlot)
        offeredTo = offer?.patientName ?? null
      }
    } else {
      await db.waitingListEntry.update({ where: { id }, data: { status: 'EXPIRED' } })
    }
    await audit('waiting.entry_removed', g.user.id, { entryId: id })
    return NextResponse.json({ ok: true, offeredTo })
  } catch (e) {
    console.error('[waiting-list PATCH]', e)
    return NextResponse.json({ error: 'Не удалось снять заявку' }, { status: 500 })
  }
}
