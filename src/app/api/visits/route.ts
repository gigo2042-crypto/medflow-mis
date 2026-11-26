// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { canEditVisitOf } from '@/lib/visit-access'
import { canTransition } from '@/lib/appointment-rules'
import { canAccessPatient, canSeeMedical, doctorFilterId, stripMedical } from '@/lib/pd-access'

export const dynamic = 'force-dynamic'

// Начать приём: создаёт визит и переводит запись в статус «В клинике»
export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'visits.write')
  if (!g.ok) return g.res
  try {
    const body = await req.json()
    const appointmentId = body.appointmentId
    if (!appointmentId) {
      return NextResponse.json({ error: 'appointmentId обязателен' }, { status: 400 })
    }
    const appt = await db.appointment.findUnique({ where: { id: appointmentId }, include: { visit: true } })
    if (!appt) {
      return NextResponse.json({ error: 'Запись не найдена' }, { status: 404 })
    }
    if (!canEditVisitOf(g.user, appt.doctorId)) {
      return NextResponse.json({ error: 'Начать можно только свой приём' }, { status: 403 })
    }
    if (!appt.visit && appt.status !== 'ARRIVED' && !canTransition(appt.status, 'ARRIVED')) {
      return NextResponse.json({ error: 'Приём в этом статусе начать нельзя' }, { status: 409 })
    }
    let visitId = appt.visit?.id
    if (!visitId) {
      const visit = await db.visit.create({
        data: { appointmentId: appt.id, patientId: appt.patientId, doctorId: appt.doctorId },
      })
      visitId = visit.id
      await audit('visit.started', g.user.id, { visitId, appointmentId: appt.id })
    }
    if (['BOOKED', 'CONFIRMED'].includes(appt.status)) {
      await db.appointment.update({ where: { id: appointmentId }, data: { status: 'ARRIVED' } })
    }
    const full = await db.visit.findUnique({
      where: { id: visitId },
      include: { patient: true, doctor: true, appointment: true, template: true },
    })
    return NextResponse.json({ visit: full }, { status: 201 })
  } catch (e) {
    console.error('[visits POST]', e)
    return NextResponse.json({ error: 'Не удалось начать приём' }, { status: 500 })
  }
}

// История визитов пациента (для карточки, ЭМК и кассы).
// Медицинские поля (жалобы, протокол, диагноз) — только medical.read (врач, админ);
// регистратор получает визиты без них (нужны цена/услуга для кассы).
// Врач (DOCTOR_SCOPE=own) — только своих пациентов; без patientId — только свои визиты.
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'visits.read')
  if (!g.ok) return g.res
  try {
    const patientId = req.nextUrl.searchParams.get('patientId')
    const appointmentId = req.nextUrl.searchParams.get('appointmentId')
    const where: Prisma.VisitWhereInput = {}
    if (patientId) {
      if (!(await canAccessPatient(g.user, patientId))) {
        return NextResponse.json({ error: 'Нет доступа к пациенту' }, { status: 403 })
      }
      where.patientId = patientId
    }
    if (appointmentId) where.appointmentId = appointmentId
    const docId = doctorFilterId(g.user)
    if (docId && !patientId) where.doctorId = docId
    const med = canSeeMedical(g.user)
    // Без medical.read (регистратор) — только выборка по пациенту/приёму: общий список визитов клиники не отдаём
    if (!med && !patientId && !appointmentId) {
      return NextResponse.json({ error: 'Общий список визитов недоступен вашей роли — укажите пациента или приём' }, { status: 403 })
    }
    const visits = await db.visit.findMany({
      where,
      include: {
        // без medical.read: только идентификация (ФИО, карта) — ни даты рождения, ни телефона, ни заметок врача
        patient: {
          select: med
            ? { id: true, lastName: true, firstName: true, middleName: true, cardNumber: true, birthDate: true, gender: true, phone: true, notes: true }
            : { id: true, lastName: true, firstName: true, middleName: true, cardNumber: true, gender: true },
        },
        doctor: { select: { name: true, specialty: true } },
        appointment: { select: { id: true, status: true, start: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    if (patientId) await audit('patient.card_read', g.user.id, { patientId, via: 'visits', medical: med })
    return NextResponse.json({ visits: visits.map((v) => stripMedical(v, med)) })
  } catch (e) {
    console.error('[visits GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить визиты' }, { status: 500 })
  }
}
