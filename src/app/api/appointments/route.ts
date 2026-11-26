// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { checkSlot } from '@/lib/schedule-days'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { dayRangeOf } from '@/lib/mis-utils'
import { createCascade } from '@/lib/reminders'
import { AppointmentDTO, SOURCE_LABELS } from '@/lib/types'
import { HIDDEN, doctorFilterId, patientAccessFor } from '@/lib/pd-access'
import { dateKey } from '@/lib/mis-utils'

export const dynamic = 'force-dynamic'

function toDTO(r: {
  id: string
  start: Date
  duration: number
  status: string
  source: string
  patientId: string
  patient: { lastName: string; firstName: string; middleName: string | null; phone: string; cardNumber: string }
  doctorId: string
  doctor: { name: string; specialty: string }
  visit?: { id: string } | null
}): AppointmentDTO {
  return {
    id: r.id,
    start: r.start.toISOString(),
    duration: r.duration,
    status: r.status,
    source: r.source,
    patientId: r.patientId,
    patientName: `${r.patient.lastName} ${r.patient.firstName}${r.patient.middleName ? ' ' + r.patient.middleName : ''}`,
    patientPhone: r.patient.phone,
    cardNumber: r.patient.cardNumber,
    doctorId: r.doctorId,
    doctorName: r.doctor.name,
    doctorSpecialty: r.doctor.specialty,
    visitId: r.visit?.id ?? null,
  }
}

export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'schedule.read')
  if (!g.ok) return g.res
  try {
    // Без даты — сегодняшний день: выгрузка «всех записей клиники» одним запросом не отдаётся
    const dateParam = req.nextUrl.searchParams.get('date') || dateKey(new Date())
    const range = dayRangeOf(dateParam)
    if (!range) return NextResponse.json({ error: 'Неверный формат даты' }, { status: 400 })
    const where: Prisma.AppointmentWhereInput = { start: range }
    // Врач (DOCTOR_SCOPE=own) — только свои записи
    const docId = doctorFilterId(g.user)
    if (docId) where.doctorId = docId
    const rows = await db.appointment.findMany({
      where,
      include: { patient: true, doctor: true, visit: { select: { id: true } } },
      orderBy: { start: 'asc' },
    })
    const appointments = rows.map((r) => {
      const dto = toDTO(r)
      const access = patientAccessFor(g.user, r.doctorId)
      if (access === 'full') return dto
      // DOCTOR_SCOPE=all: чужие пациенты — без телефона; без права на ПДн — без ФИО и карты
      return {
        ...dto,
        patientPhone: '',
        patientName: access === 'name' ? dto.patientName : HIDDEN,
        cardNumber: access === 'name' ? dto.cardNumber : HIDDEN,
      }
    })
    return NextResponse.json({ appointments, sources: SOURCE_LABELS })
  } catch (e) {
    console.error('[appointments GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить записи' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'appointments.create')
  if (!g.ok) return g.res
  try {
    const body = await req.json()
    const { patientId, doctorId, start, source } = body
    if (!patientId || !doctorId || !start) {
      return NextResponse.json({ error: 'patientId, doctorId и start обязательны' }, { status: 400 })
    }
    const startDt = new Date(start)
    const doctor = await db.doctor.findUnique({ where: { id: doctorId } })
    if (!doctor) {
      return NextResponse.json({ error: 'Врач не найден' }, { status: 404 })
    }
    const err = await checkSlot(doctor, startDt)
    if (err) return NextResponse.json({ error: err }, { status: 400 })
    const appointment = await db.appointment.create({
      data: {
        patientId,
        doctorId,
        start: startDt,
        duration: doctor.slotMinutes,
        source: source && SOURCE_LABELS[source] ? source : 'REGISTRAR',
      },
    })
    await audit('appointment.created', g.user.id, { appointmentId: appointment.id, doctorId, start: startDt.toISOString(), source })
    // ФТ-005: каскад напоминаний создаётся сразу при записи
    const remindersCreated = await createCascade(appointment.id)
    return NextResponse.json({ appointment, remindersCreated }, { status: 201 })
  } catch (e) {
    // Точка улучшения №6: двойная бронь невозможна
    if (e && typeof e === 'object' && 'code' in e && e.code === 'P2002') {
      return NextResponse.json({ error: 'Слот уже занят — двойная бронь заблокирована' }, { status: 409 })
    }
    console.error('[appointments POST]', e)
    return NextResponse.json({ error: 'Не удалось создать запись' }, { status: 500 })
  }
}
