// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePerm } from '@/lib/auth-server'
import { DocCtx, renderTemplate } from '@/lib/doc-render'
import { clinic } from '@/lib/clinic'
import { canAccessPatient, canSeeMedical } from '@/lib/pd-access'

export const dynamic = 'force-dynamic'

// Рендер печатной формы с подстановками данных пациента/визита (ФТ-009)
export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'docs.read')
  if (!g.ok) return g.res
  try {
    const { patientId, templateId, visitId } = await req.json()
    // врач (DOCTOR_SCOPE=own) формирует документы только для своих пациентов
    if (!patientId || !(await canAccessPatient(g.user, String(patientId)))) {
      return NextResponse.json({ error: 'Нет доступа к пациенту' }, { status: 403 })
    }
    const med = canSeeMedical(g.user)
    // В production без реквизитов клиники (CLINIC_*) документы не формируются
    const c = clinic()
    if (!c.configured) {
      return NextResponse.json({ error: `Реквизиты клиники не заданы (${c.missing.join(', ')}) — печать документов недоступна`, code: 'CLINIC_NOT_CONFIGURED' }, { status: 409 })
    }
    const template = await db.documentTemplate.findUnique({ where: { id: templateId } })
    if (!template || !template.active) {
      return NextResponse.json({ error: 'Шаблон не найден' }, { status: 404 })
    }
    const patient = await db.patient.findUnique({ where: { id: patientId } })
    if (!patient) {
      return NextResponse.json({ error: 'Пациент не найден' }, { status: 404 })
    }
    let visit: { patientId: string; doctor: { name: string; specialty: string }; appointment: { start: Date }; diagnosisCode: string | null; diagnosisName: string | null; price: number } | null = null
    let doctor: { name: string; specialty: string } | null = null
    if (visitId) {
      visit = await db.visit.findUnique({
        where: { id: visitId },
        include: { doctor: { select: { name: true, specialty: true } }, appointment: { select: { start: true } } },
      })
      if (!visit || visit.patientId !== patientId) {
        return NextResponse.json({ error: 'Приём не относится к выбранному пациенту' }, { status: 400 })
      }
      doctor = visit.doctor
    } else {
      // без выбранного приёма подставляем врача из последнего визита пациента, если есть
      const last = await db.visit.findFirst({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
        include: { doctor: { select: { name: true, specialty: true } } },
      })
      doctor = last?.doctor || null
    }

    const ctx: DocCtx = {
      patient: {
        cardNumber: patient.cardNumber,
        lastName: patient.lastName,
        firstName: patient.firstName,
        middleName: patient.middleName,
        phone: patient.phone,
        birthDate: patient.birthDate,
        gender: patient.gender,
      },
      doctor,
      // диагноз подставляется только при medical.read — как и при сохранении документа (documents POST)
      visit: visit ? { start: visit.appointment.start, diagnosisCode: med ? visit.diagnosisCode : null, diagnosisName: med ? visit.diagnosisName : null, price: visit.price } : null,
      staffName: g.user.name,
      clinic: c,
    }
    const content = renderTemplate(template.body, ctx)
    return NextResponse.json({ title: template.name, content })
  } catch (e) {
    console.error('[doc-templates/render POST]', e)
    return NextResponse.json({ error: 'Не удалось подготовить документ' }, { status: 500 })
  }
}
