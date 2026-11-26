// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { DocCtx, renderTemplate } from '@/lib/doc-render'
import { clinic } from '@/lib/clinic'
import { canAccessPatient, canSeeMedical, doctorFilterId } from '@/lib/pd-access'

export const dynamic = 'force-dynamic'

// Архив документов пациента (ФТ-009): список + полный текст для повторной печати
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'docs.read')
  if (!g.ok) return g.res
  try {
    const patientId = req.nextUrl.searchParams.get('patientId')
    if (patientId && !(await canAccessPatient(g.user, patientId))) {
      return NextResponse.json({ error: 'Нет доступа к пациенту' }, { status: 403 })
    }
    const docId = doctorFilterId(g.user)
    const rows = await db.signedDocument.findMany({
      where: patientId ? { patientId } : docId ? { patient: { appointments: { some: { doctorId: docId } } } } : undefined,
      include: {
        patient: { select: { lastName: true, firstName: true, cardNumber: true } },
        template: { select: { name: true, kind: true, body: true } },
        createdBy: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: patientId ? undefined : 50,
    })
    // Документы с диагнозом (шаблон содержит {{visit.diagnosis}}) — текст только для medical.read
    const med = canSeeMedical(g.user)
    const documents = rows.map((d) => ({
      id: d.id,
      patientId: d.patientId,
      patientName: `${d.patient.lastName} ${d.patient.firstName}`,
      cardNumber: d.patient.cardNumber,
      title: d.title,
      kind: d.template.kind,
      templateName: d.template.name,
      content: !med && d.template.body.includes('visit.diagnosis') ? 'Документ содержит медицинские сведения — текст доступен лечащему врачу.' : d.content,
      signed: d.signed,
      signedAt: d.signedAt?.toISOString() || null,
      createdByName: d.createdBy?.name || null,
      createdAt: d.createdAt.toISOString(),
    }))
    return NextResponse.json({ documents })
  } catch (e) {
    console.error('[documents GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить документы' }, { status: 500 })
  }
}

// Сохранение документа с клик-подписью пациента (ФТ-009, ФТ-054)
// Содержимое всегда перерендеривается на сервере — клиент не может подменить текст
export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'docs.sign')
  if (!g.ok) return g.res
  try {
    const { patientId, templateId, visitId, signed } = await req.json()
    if (!patientId || !(await canAccessPatient(g.user, String(patientId)))) {
      return NextResponse.json({ error: 'Нет доступа к пациенту' }, { status: 403 })
    }
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
    let doctor: { name: string; specialty: string } | null = null
    let visit: { patientId: string; doctor: { name: string; specialty: string }; appointment: { start: Date }; diagnosisCode: string | null; diagnosisName: string | null; price: number } | null = null
    if (visitId) {
      visit = await db.visit.findUnique({
        where: { id: visitId },
        include: { doctor: { select: { name: true, specialty: true } }, appointment: { select: { start: true } } },
      })
      if (!visit || visit.patientId !== patientId) {
        return NextResponse.json({ error: 'Приём не относится к выбранному пациенту' }, { status: 400 })
      }
      doctor = visit.doctor
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
      // диагноз подставляется, только если документ формирует сотрудник с medical.read
      visit: visit
        ? {
            start: visit.appointment.start,
            diagnosisCode: canSeeMedical(g.user) ? visit.diagnosisCode : null,
            diagnosisName: canSeeMedical(g.user) ? visit.diagnosisName : null,
            price: visit.price,
          }
        : null,
      staffName: g.user.name,
      clinic: c,
    }
    const content = renderTemplate(template.body, ctx)
    const doc = await db.signedDocument.create({
      data: {
        patientId,
        templateId,
        visitId: visitId || undefined,
        title: template.name,
        content,
        signed: Boolean(signed),
        signedAt: signed ? new Date() : null,
        createdById: g.user.id,
      },
    })
    await audit(signed ? 'document.signed' : 'document.created', g.user.id, {
      documentId: doc.id,
      template: template.code,
      patient: `${patient.lastName} ${patient.firstName}`,
    })
    return NextResponse.json({ document: doc }, { status: 201 })
  } catch (e) {
    console.error('[documents POST]', e)
    return NextResponse.json({ error: 'Не удалось сохранить документ' }, { status: 500 })
  }
}
