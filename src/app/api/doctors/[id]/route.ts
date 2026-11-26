// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { minutesOf } from '@/lib/mis-utils'

export const dynamic = 'force-dynamic'

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

// График врача: рабочие дни недели, часы, длительность слота (только администратор)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requirePerm(req, 'settings.manage')
  if (!g.ok) return g.res
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const doc = await db.doctor.findUnique({ where: { id } })
  if (!doc) return NextResponse.json({ error: 'Врач не найден' }, { status: 404 })
  const data: { workDays?: string; workStart?: string; workEnd?: string; slotMinutes?: number } = {}
  if (body.workDays !== undefined) {
    if (!/^[01]{7}$/.test(String(body.workDays))) return NextResponse.json({ error: 'workDays: 7 символов 0/1 (Пн..Вс)' }, { status: 400 })
    data.workDays = String(body.workDays)
  }
  for (const k of ['workStart', 'workEnd'] as const) {
    if (body[k] !== undefined) {
      if (!TIME_RE.test(String(body[k]))) return NextResponse.json({ error: `${k}: формат ЧЧ:ММ` }, { status: 400 })
      data[k] = String(body[k])
    }
  }
  if (body.slotMinutes !== undefined) {
    const n = Number(body.slotMinutes)
    if (!Number.isInteger(n) || n < 5 || n > 240) return NextResponse.json({ error: 'slotMinutes: от 5 до 240' }, { status: 400 })
    data.slotMinutes = n
  }
  const ws = data.workStart ?? doc.workStart
  const we = data.workEnd ?? doc.workEnd
  if (minutesOf(ws) >= minutesOf(we)) return NextResponse.json({ error: 'Начало работы должно быть раньше окончания' }, { status: 400 })
  const updated = await db.doctor.update({ where: { id }, data })
  await audit('doctor.schedule_updated', g.user.id, { doctorId: id, ...data })
  return NextResponse.json({ doctor: { id: updated.id, workDays: updated.workDays, workStart: updated.workStart, workEnd: updated.workEnd, slotMinutes: updated.slotMinutes } })
}
