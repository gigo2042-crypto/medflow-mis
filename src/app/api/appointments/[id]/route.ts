// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { checkSlot } from '@/lib/schedule-days'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { cancelPlanned, createCascade } from '@/lib/reminders'
import { offerFreedSlot } from '@/lib/waiting'
import { STATUS_LABELS } from '@/lib/types'
import { canReschedule, canTransition } from '@/lib/appointment-rules'

export const dynamic = 'force-dynamic'

const ALLOWED = Object.keys(STATUS_LABELS)

// PATCH: смена статуса (по таблице допустимых переходов) или перенос записи
// body: { status } | { action: 'RESCHEDULE', start, doctorId? }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requirePerm(req, 'appointments.update')
  if (!g.ok) return g.res
  try {
    const { id } = await params
    const body = await req.json()
    const current = await db.appointment.findUnique({ where: { id } })
    if (!current) return NextResponse.json({ error: 'Запись не найдена' }, { status: 404 })

    if (body.action === 'RESCHEDULE') {
      if (!canReschedule(current.status)) {
        return NextResponse.json({ error: 'Перенести можно только запись в статусе «Записан» или «Подтверждён»' }, { status: 409 })
      }
      const doctorId: string = body.doctorId || current.doctorId
      const doctor = await db.doctor.findUnique({ where: { id: doctorId } })
      if (!doctor) return NextResponse.json({ error: 'Врач не найден' }, { status: 404 })
      const newStart = new Date(body.start)
      const err = await checkSlot(doctor, newStart)
      if (err) return NextResponse.json({ error: err }, { status: 400 })
      if (newStart.getTime() === current.start.getTime() && doctorId === current.doctorId) {
        return NextResponse.json({ error: 'Выбран тот же слот' }, { status: 400 })
      }
      const busy = await db.appointment.findFirst({
        where: { doctorId, start: newStart, status: { notIn: ['CANCELED', 'NO_SHOW'] }, id: { not: id } },
      })
      if (busy) return NextResponse.json({ error: 'Слот уже занят — выберите другой' }, { status: 409 })
      const oldStart = current.start
      const oldDoctorId = current.doctorId
      let updated
      try {
        updated = await db.appointment.update({
          where: { id },
          data: { start: newStart, doctorId, duration: doctor.slotMinutes, status: 'BOOKED' },
          include: { patient: true, doctor: true, visit: { select: { id: true } } },
        })
      } catch (e) {
        if (e && typeof e === 'object' && 'code' in e && e.code === 'P2002') {
          return NextResponse.json({ error: 'Слот уже занят — двойная бронь заблокирована' }, { status: 409 })
        }
        throw e
      }
      // Каскад напоминаний пересоздаётся под новое время
      await cancelPlanned(id)
      const remindersCreated = await createCascade(id)
      // Освободившийся слот предлагается листу ожидания
      let waitingOffer: { patientName: string; notificationStatus: string } | null = null
      if (oldStart.getTime() > Date.now()) {
        const offer = await offerFreedSlot(oldDoctorId, oldStart)
        waitingOffer = offer ? { patientName: offer.patientName, notificationStatus: offer.notificationStatus } : null
      }
      await audit('appointment.rescheduled', g.user.id, {
        appointmentId: id,
        from: oldStart.toISOString(),
        to: newStart.toISOString(),
        doctorFrom: oldDoctorId,
        doctorTo: doctorId,
      })
      return NextResponse.json({ appointment: updated, remindersCreated, waitingOffer })
    }

    if (!body.status || !ALLOWED.includes(body.status)) {
      return NextResponse.json({ error: 'Недопустимый статус' }, { status: 400 })
    }
    if (!canTransition(current.status, body.status)) {
      return NextResponse.json(
        { error: `Нельзя перевести запись из «${STATUS_LABELS[current.status] ?? current.status}» в «${STATUS_LABELS[body.status] ?? body.status}»` },
        { status: 409 }
      )
    }
    const appointment = await db.appointment.update({
      where: { id },
      data: { status: body.status },
      include: { patient: true, doctor: true, visit: { select: { id: true } } },
    })
    await audit('appointment.status_changed', g.user.id, { appointmentId: id, from: current.status, status: body.status })

    // Отмена/неявка: гасим каскад напоминаний и автоприглашаем пациента из листа ожидания
    let waitingOffer: { patientName: string; notificationStatus: string } | null = null
    if (['CANCELED', 'NO_SHOW'].includes(body.status)) {
      await cancelPlanned(id)
      if (appointment.start.getTime() > Date.now()) {
        const offer = await offerFreedSlot(appointment.doctorId, appointment.start)
        waitingOffer = offer ? { patientName: offer.patientName, notificationStatus: offer.notificationStatus } : null
      }
    }
    return NextResponse.json({ appointment, waitingOffer })
  } catch (e) {
    console.error('[appointments PATCH]', e)
    return NextResponse.json({ error: 'Не удалось обновить запись' }, { status: 500 })
  }
}
