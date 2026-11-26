// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePerm } from '@/lib/auth-server'
import { dateKey, dayRangeOf, parseDateKey, timeStr, zonedTime } from '@/lib/mis-utils'
import { DoctorSchedule, Slot } from '@/lib/types'
import { patientAccessFor } from '@/lib/pd-access'
import { hoursOn } from '@/lib/appointment-rules'
import { exceptionsBetween } from '@/lib/schedule-days'

export const dynamic = 'force-dynamic'

// Расписание дня со слотами; занятые слоты блокируются на уровне БД (точка улучшения №6)
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'schedule.read')
  if (!g.ok) return g.res
  try {
    const dateParam = req.nextUrl.searchParams.get('date') || dateKey(new Date())
    const k = parseDateKey(dateParam)
    const range = dayRangeOf(dateParam)
    if (!k || !range) {
      return NextResponse.json({ error: 'Неверный формат даты' }, { status: 400 })
    }
    const { y, m, d } = k
    // Сутки и рабочие часы врача — в поясе клиники (CLINIC_TZ), а не сервера
    const dayStart = range.gte
    const dayEnd = range.lt
    const now = new Date()

    const doctors = await db.doctor.findMany({ orderBy: { name: 'asc' } })
    const exceptions = await exceptionsBetween(dateParam, dateParam)
    const appts = await db.appointment.findMany({
      where: { start: { gte: dayStart, lt: dayEnd }, status: { notIn: ['CANCELED'] } },
      include: { patient: true },
    })

    const ACTIVE = ['BOOKED', 'CONFIRMED', 'ARRIVED', 'DONE']
    const schedules: DoctorSchedule[] = doctors.map((doc) => {
      const hours = hoursOn(doc, dateParam, exceptions)
      const [sh, sm] = (hours.off ? doc.workStart : hours.workStart).split(':').map(Number)
      const [eh, em] = (hours.off ? doc.workStart : hours.workEnd).split(':').map(Number)
      const start0 = zonedTime(y, m, d, sh, sm)
      const end0 = zonedTime(y, m, d, eh, em)
      // на слоте может быть неявка и новая активная запись — показываем активную
      const byStart = new Map<number, (typeof appts)[number]>()
      for (const a of appts.filter((x) => x.doctorId === doc.id)) {
        const prev = byStart.get(a.start.getTime())
        if (!prev || (!ACTIVE.includes(prev.status) && ACTIVE.includes(a.status))) byStart.set(a.start.getTime(), a)
      }
      // записи вне рабочих часов (до изменения графика) тоже видны
      const extra = hours.off ? [...byStart.values()].filter((a) => ACTIVE.includes(a.status)) : []
      const slots: Slot[] = []
      for (let t = start0.getTime(); t < end0.getTime(); t += doc.slotMinutes * 60000) {
        const s = new Date(t)
        const a = byStart.get(t)
        let status: Slot['status'] = 'FREE'
        if (a && ['BOOKED', 'CONFIRMED', 'ARRIVED', 'DONE'].includes(a.status)) status = 'BOOKED'
        else if (t < now.getTime()) status = 'PAST'
        slots.push({
          start: s.toISOString(),
          time: timeStr(s),
          end: timeStr(new Date(t + doc.slotMinutes * 60000)),
          status,
          appointmentId: a?.id,
          // чужие записи врачу (DOCTOR_SCOPE=own) — только «занято», без пациента
          patientId: a && patientAccessFor(g.user, doc.id) !== 'none' ? a.patientId : undefined,
          patientName: a && patientAccessFor(g.user, doc.id) !== 'none' ? `${a.patient.lastName} ${a.patient.firstName}` : undefined,
          apptStatus: a?.status,
          source: a?.source,
        })
      }
      return {
        id: doc.id,
        name: doc.name,
        specialty: doc.specialty,
        color: doc.color,
        workStart: doc.workStart,
        workEnd: doc.workEnd,
        workDays: doc.workDays,
        slotMinutes: doc.slotMinutes,
        dayOff: hours.off ? hours.reason : null,
        slots: hours.off
          ? extra.map((a) => ({
              start: a.start.toISOString(),
              time: timeStr(a.start),
              end: timeStr(new Date(a.start.getTime() + doc.slotMinutes * 60000)),
              status: 'BOOKED' as const,
              appointmentId: a.id,
              patientId: patientAccessFor(g.user, doc.id) !== 'none' ? a.patientId : undefined,
              patientName: patientAccessFor(g.user, doc.id) !== 'none' ? `${a.patient.lastName} ${a.patient.firstName}` : undefined,
              apptStatus: a.status,
              source: a.source,
            }))
          : slots,
      }
    })

    return NextResponse.json({ date: dateParam, schedules })
  } catch (e) {
    console.error('[schedule GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить расписание' }, { status: 500 })
  }
}
