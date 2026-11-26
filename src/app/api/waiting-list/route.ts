// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { WaitingEntryDTO, WaitingStats } from '@/lib/types'

export const dynamic = 'force-dynamic'

type EntryRow = {
  id: string
  patientId: string
  doctorId: string | null
  specialty: string | null
  serviceId: string | null
  daysMask: string
  fromTime: string
  toTime: string
  priority: number
  status: string
  comment: string | null
  createdAt: Date
  offeredDoctorId: string | null
  offeredSlot: Date | null
  offeredAt: Date | null
  offerExpiresAt: Date | null
  bookedAppointmentId: string | null
  patient: { lastName: string; firstName: string; middleName: string | null; phone: string; cardNumber: string }
  doctor: { name: string } | null
  offeredDoctor: { name: string } | null
  service: { name: string } | null
}

function toDTO(r: EntryRow, position: number | null): WaitingEntryDTO {
  return {
    id: r.id,
    position,
    patientId: r.patientId,
    patientName: `${r.patient.lastName} ${r.patient.firstName}${r.patient.middleName ? ' ' + r.patient.middleName : ''}`,
    patientPhone: r.patient.phone,
    cardNumber: r.patient.cardNumber,
    doctorId: r.doctorId,
    doctorName: r.doctor?.name ?? null,
    specialty: r.specialty,
    serviceId: r.serviceId,
    serviceName: r.service?.name ?? null,
    daysMask: r.daysMask,
    fromTime: r.fromTime,
    toTime: r.toTime,
    priority: r.priority,
    status: r.status,
    comment: r.comment,
    createdAt: r.createdAt.toISOString(),
    offeredDoctorId: r.offeredDoctorId,
    offeredDoctorName: r.offeredDoctor?.name ?? null,
    offeredSlot: r.offeredSlot?.toISOString() ?? null,
    offeredAt: r.offeredAt?.toISOString() ?? null,
    offerExpiresAt: r.offerExpiresAt?.toISOString() ?? null,
    bookedAppointmentId: r.bookedAppointmentId,
  }
}

// Лист ожидания (ФТ-004): очередь + статистика конверсии в запись
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'waitinglist.read')
  if (!g.ok) return g.res
  try {
    // истёкшие предложения гасит планировщик (reminders PROCESS) — GET ничего не меняет и не шлёт SMS (3.7)
    const showAll = req.nextUrl.searchParams.get('status') === 'all'
    const rows = await db.waitingListEntry.findMany({
      where: showAll ? {} : { status: { in: ['ACTIVE', 'OFFERED'] } },
      include: { patient: true, doctor: true, offeredDoctor: true, service: true },
      orderBy: { createdAt: 'asc' },
    })
    // FIFO с учётом приоритета: срочные вперёд, внутри — по дате постановки
    const activeOrder = rows
      .filter((r) => r.status === 'ACTIVE')
      .sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime())
    const posMap = new Map(activeOrder.map((r, i) => [r.id, i + 1]))

    const orderRank = (s: string): number => (s === 'OFFERED' ? 0 : s === 'ACTIVE' ? 1 : 2)
    const entries = rows
      .map((r) => toDTO(r as EntryRow, posMap.get(r.id) ?? null))
      .sort((a, b) => orderRank(a.status) - orderRank(b.status) || (a.position ?? 99) - (b.position ?? 99))

    const count = (s: string) => rows.filter((r) => r.status === s).length
    const booked = count('BOOKED')
    const declined = count('DECLINED')
    const expired = count('EXPIRED')
    const stats: WaitingStats = {
      active: count('ACTIVE'),
      offered: count('OFFERED'),
      booked,
      declined,
      expired,
      conversion: Math.round((booked / Math.max(1, booked + declined + expired)) * 100),
      total: rows.length,
    }
    return NextResponse.json({ entries, stats })
  } catch (e) {
    console.error('[waiting-list GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить лист ожидания' }, { status: 500 })
  }
}

// Поставить пациента в лист ожидания (ФТ-004: желаемые врач/услуга/окно/дни + приоритет)
export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'waitinglist.manage')
  if (!g.ok) return g.res
  try {
    const body = await req.json()
    const { patientId, doctorId, specialty, serviceId, daysMask, fromTime, toTime, priority, comment } = body
    if (!patientId) {
      return NextResponse.json({ error: 'Укажите пациента' }, { status: 400 })
    }
    const patient = await db.patient.findUnique({ where: { id: patientId } })
    if (!patient) return NextResponse.json({ error: 'Пациент не найден' }, { status: 404 })
    if (doctorId) {
      const doctor = await db.doctor.findUnique({ where: { id: doctorId } })
      if (!doctor) return NextResponse.json({ error: 'Врач не найден' }, { status: 404 })
    }
    if (serviceId) {
      const service = await db.serviceItem.findUnique({ where: { id: serviceId } })
      if (!service) return NextResponse.json({ error: 'Услуга не найдена' }, { status: 404 })
    }
    const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/
    const ft = fromTime || '08:00'
    const tt = toTime || '20:00'
    if (!timeRe.test(ft) || !timeRe.test(tt) || ft >= tt) {
      return NextResponse.json({ error: 'Неверное окно времени' }, { status: 400 })
    }
    const mask = daysMask && /^[01]{7}$/.test(daysMask) && daysMask.includes('1') ? daysMask : '1111111'
    if (priority !== undefined && ![0, 1].includes(Number(priority))) {
      return NextResponse.json({ error: 'Приоритет: 0 (обычный) или 1 (срочный)' }, { status: 400 })
    }
    const entry = await db.waitingListEntry.create({
      data: {
        patientId,
        doctorId: doctorId || null,
        specialty: doctorId ? null : specialty || null,
        serviceId: serviceId || null,
        daysMask: mask,
        fromTime: ft,
        toTime: tt,
        priority: Number(priority) || 0,
        comment: comment || null,
      },
      include: { patient: true, doctor: true, offeredDoctor: true, service: true },
    })
    await audit('waiting.entry_created', g.user.id, {
      entryId: entry.id,
      patientId,
      doctorId: doctorId || null,
      specialty: doctorId ? null : specialty || null,
      priority: Number(priority) || 0,
    })
    return NextResponse.json({ entry: toDTO(entry as EntryRow, null) }, { status: 201 })
  } catch (e) {
    console.error('[waiting-list POST]', e)
    return NextResponse.json({ error: 'Не удалось добавить в лист ожидания' }, { status: 500 })
  }
}
