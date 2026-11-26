// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { llm, llmEnabled, llmTarget, promptHash } from '@/lib/ai-client'
import { ddmmyyyy } from '@/lib/mis-utils'
import { ageOf, pseudonymize } from '@/lib/ai-protocol'
import { canAccessPatient, canSeeMedical } from '@/lib/pd-access'

export const dynamic = 'force-dynamic'

// AI-резюме истории пациента перед приёмом. В модель уходят пол, возраст и история
// без ФИО, номера карты и контактов (псевдонимизация, 152-ФЗ).
export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'ai.summary')
  if (!g.ok) return g.res
  try {
    const body = await req.json()
    const patientId = body.patientId
    if (!patientId) {
      return NextResponse.json({ error: 'patientId обязателен' }, { status: 400 })
    }
    // AI-сводка содержит диагнозы — врачебная тайна: только medical.read и «свой» пациент
    if (!canSeeMedical(g.user) || !(await canAccessPatient(g.user, String(patientId)))) {
      return NextResponse.json({ error: 'Сводка по истории доступна только лечащему врачу' }, { status: 403 })
    }
    const patient = await db.patient.findUnique({
      where: { id: String(patientId) },
      include: {
        visits: {
          include: { doctor: { select: { specialty: true } }, appointment: { select: { start: true } } },
          orderBy: { createdAt: 'desc' },
          take: 8,
        },
      },
    })
    if (!patient) {
      return NextResponse.json({ error: 'Пациент не найден' }, { status: 404 })
    }
    const names = [patient.lastName, patient.firstName, patient.middleName ?? '']
    const contacts = { phones: [patient.phone], emails: patient.email ? [patient.email] : [] }
    const history = patient.visits
      .map((v) => {
        const dt = ddmmyyyy(v.appointment?.start ?? v.createdAt)
        return `${dt} — ${v.doctor.specialty}: жалобы: ${v.complaints ? pseudonymize(v.complaints, names, contacts) : '—'}; диагноз: ${v.diagnosisCode || '—'} ${v.diagnosisName || ''}`
      })
      .join('\n')
    await audit('patient.card_read', g.user.id, { patientId: patient.id, via: 'ai.summary' })

    if (llmEnabled() && body.localOnly !== true) {
      const system =
        'Ты медицинский ассистент МИС. Составь краткое резюме истории пациента (3-4 предложения) на русском языке для врача перед приёмом: частые обращения, основные диагнозы, что важно учесть. Не выдумывай данных — используй только предоставленную историю. Ответ — только текст резюме.'
      const age = ageOf(patient.birthDate)
      const user = `Пациент: пол ${patient.gender === 'F' ? 'женский' : 'мужской'}${age !== null ? `, возраст ${age}` : ''}.\nИстория обращений:\n${history || 'обращений не было'}`
      const hash = promptHash(system, user)
      if (body.confirmHash !== hash) {
        // Превью для врача: в модель пока ничего не ушло
        return NextResponse.json({ needConfirm: true, preview: user, previewHash: hash, target: llmTarget(), changed: Boolean(body.confirmHash) })
      }
      await audit('ai.summary_sent', g.user.id, { patientId, provider: llmTarget().provider, chars: user.length })
      const text = await llm(system, user)
      if (text) {
        await audit('ai.summary_requested', g.user.id, { patientId, ai: true })
        return NextResponse.json({ summary: text, ai: true })
      }
    }
    const fallback = history ? `Последние обращения:\n${history}` : 'История обращений отсутствует.'
    return NextResponse.json({ summary: fallback, ai: false })
  } catch (e) {
    console.error('[ai/summary POST]', e)
    return NextResponse.json({ error: 'Ошибка генерации резюме' }, { status: 500 })
  }
}
