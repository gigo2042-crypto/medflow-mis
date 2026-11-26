// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { addDaysKey, dayRangeOf, minutesOf, parseDateKey, todayKey } from '@/lib/mis-utils'

export const dynamic = 'force-dynamic'

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

// Исключения графика: праздники клиники, отпуска/больничные врачей, особые часы
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'schedule.read')
  if (!g.ok) return g.res
  const from = req.nextUrl.searchParams.get('from') || todayKey()
  const to = req.nextUrl.searchParams.get('to') || addDaysKey(from, 90)
  if (!parseDateKey(from) || !parseDateKey(to)) return NextResponse.json({ error: 'Неверный формат даты' }, { status: 400 })
  const rows = await db.scheduleException.findMany({
    where: { date: { gte: from, lte: to } },
    include: { doctor: { select: { name: true } } },
    orderBy: [{ date: 'asc' }],
  })
  return NextResponse.json({
    exceptions: rows.map((r) => ({ id: r.id, doctorId: r.doctorId, doctorName: r.doctor?.name ?? null, date: r.date, kind: r.kind, workStart: r.workStart, workEnd: r.workEnd, reason: r.reason })),
  })
}

export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'settings.manage')
  if (!g.ok) return g.res
  const body = await req.json().catch(() => ({}))
  const date = String(body.date || '')
  const dateTo = String(body.dateTo || date) // диапазон (отпуск) — по записи на день
  const kind = body.kind === 'HOURS' ? 'HOURS' : 'OFF'
  const doctorId = body.doctorId ? String(body.doctorId) : null
  if (!parseDateKey(date) || !parseDateKey(dateTo) || dateTo < date) return NextResponse.json({ error: 'Укажите дату (YYYY-MM-DD)' }, { status: 400 })
  if (doctorId && !(await db.doctor.findUnique({ where: { id: doctorId } }))) return NextResponse.json({ error: 'Врач не найден' }, { status: 404 })
  let workStart: string | null = null
  let workEnd: string | null = null
  if (kind === 'HOURS') {
    workStart = String(body.workStart || '')
    workEnd = String(body.workEnd || '')
    if (!TIME_RE.test(workStart) || !TIME_RE.test(workEnd) || minutesOf(workStart) >= minutesOf(workEnd)) {
      return NextResponse.json({ error: 'Особые часы: ЧЧ:ММ, начало раньше окончания' }, { status: 400 })
    }
  }
  const days: string[] = []
  for (let k = date; k <= dateTo && days.length < 62; k = addDaysKey(k, 1)) days.push(k)
  const reason = body.reason ? String(body.reason).slice(0, 200) : null
  await db.$transaction([
    db.scheduleException.deleteMany({ where: { doctorId, date: { in: days } } }),
    db.scheduleException.createMany({ data: days.map((d) => ({ doctorId, date: d, kind, workStart, workEnd, reason })) }),
  ])
  // активные записи, попавшие на нерабочий день, — регистратуре нужно их перенести
  const affected = kind === 'OFF'
    ? await db.appointment.count({
        where: {
          status: { in: ['BOOKED', 'CONFIRMED'] },
          ...(doctorId ? { doctorId } : {}),
          start: { gte: dayRangeOf(date)!.gte, lt: dayRangeOf(dateTo)!.lt },
        },
      })
    : 0
  await audit('schedule.exception_set', g.user.id, { doctorId, date, dateTo, kind })
  return NextResponse.json({ ok: true, days: days.length, affectedAppointments: affected }, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const g = await requirePerm(req, 'settings.manage')
  if (!g.ok) return g.res
  const id = req.nextUrl.searchParams.get('id') || ''
  const r = await db.scheduleException.deleteMany({ where: { id } })
  if (r.count === 0) return NextResponse.json({ error: 'Не найдено' }, { status: 404 })
  await audit('schedule.exception_removed', g.user.id, { id })
  return NextResponse.json({ ok: true })
}
