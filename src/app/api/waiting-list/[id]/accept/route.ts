// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { audit, requirePerm } from '@/lib/auth-server'
import { bookFromWaiting, WaitingError } from '@/lib/waiting'

export const dynamic = 'force-dynamic'

// Принять предложение / вручную записать пациента из листа ожидания (ФТ-004: конверсия в запись)
// body: { start?, doctorId? } — для ручной рассадки из очереди (status=ACTIVE)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requirePerm(req, 'waitinglist.manage')
  if (!g.ok) return g.res
  try {
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const r = await bookFromWaiting(id, { doctorId: body.doctorId ?? null, start: body.start ?? null, source: 'REGISTRAR' })
    await audit('waiting.booked', g.user.id, { entryId: id, appointmentId: r.appointmentId, fromOffer: r.fromOffer })
    return NextResponse.json(
      { appointment: { id: r.appointmentId, start: r.start.toISOString(), doctorId: r.doctorId }, remindersCreated: r.remindersCreated },
      { status: 201 }
    )
  } catch (e) {
    if (e instanceof WaitingError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('[waiting-list accept]', e)
    return NextResponse.json({ error: 'Не удалось записать пациента' }, { status: 500 })
  }
}
