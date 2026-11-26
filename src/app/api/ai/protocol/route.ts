// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { llm, llmEnabled, llmTarget, promptHash } from '@/lib/ai-client'
import { buildProtocolPrompt, fallbackProtocol, validateProtocol, ProtocolInput } from '@/lib/ai-protocol'
import { resolveIcd } from '@/lib/icd-db'

export const dynamic = 'force-dynamic'

// AI-черновик протокола приёма — только врач и администратор.
// В модель не уходят ФИО, номер карты и контакты; диагноз — только из справочника МКБ.
// Двухшаговая отправка: сначала врач видит ровно тот текст, что уйдёт в модель (preview),
// затем подтверждает — сервер собирает текст заново и сверяет хеш (confirmHash).
export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'ai.protocol')
  if (!g.ok) return g.res
  try {
    const body = await req.json()
    let patientNames: string[] = []
    let patientContacts: { phones: string[]; emails: string[] } = { phones: [], emails: [] }
    if (body.visitId) {
      const v = await db.visit.findUnique({ where: { id: String(body.visitId) }, include: { patient: true } })
      if (!v) return NextResponse.json({ error: 'Визит не найден' }, { status: 404 })
      if (g.user.role === 'DOCTOR' && v.doctorId !== g.user.doctorId) {
        return NextResponse.json({ error: 'Это приём другого врача' }, { status: 403 })
      }
      patientNames = [v.patient.lastName, v.patient.firstName, v.patient.middleName ?? '']
      patientContacts = { phones: [v.patient.phone], emails: v.patient.email ? [v.patient.email] : [] }
    }
    const input: ProtocolInput = {
      specialty: String(body.specialty || '').slice(0, 100),
      complaints: String(body.complaints || ''),
      notes: String(body.notes || ''),
      anamnesis: String(body.anamnesis || ''),
      selections: body.selections && typeof body.selections === 'object' ? body.selections : {},
      diagnosisCode: body.diagnosisCode ? String(body.diagnosisCode) : null,
      diagnosis: body.diagnosisCode ? await resolveIcd(String(body.diagnosisCode)) : null,
      patientNames,
      patientPhones: patientContacts.phones,
      patientEmails: patientContacts.emails,
    }
    const templateName = String(body.templateName || '')
    if (llmEnabled() && body.localOnly !== true) {
      const { system, user, icd } = buildProtocolPrompt(input)
      const hash = promptHash(system, user)
      if (body.confirmHash !== hash) {
        // Превью: в модель пока ничего не ушло
        return NextResponse.json({
          needConfirm: true,
          preview: user,
          previewHash: hash,
          target: llmTarget(),
          changed: Boolean(body.confirmHash),
        })
      }
      await audit('ai.protocol_sent', g.user.id, { visitId: body.visitId ?? null, provider: llmTarget().provider, chars: user.length })
      const text = await llm(system, user)
      if (text) {
        const v = validateProtocol(text, icd)
        if (v.ok) {
          await audit('ai.protocol_generated', g.user.id, { visitId: body.visitId ?? null })
          return NextResponse.json({ protocol: v.protocol, ai: true })
        }
        console.warn('[ai/protocol] ответ модели отклонён:', v.reason)
      }
    }
    return NextResponse.json({ protocol: fallbackProtocol(input, templateName), ai: false })
  } catch (e) {
    console.error('[ai/protocol POST]', e)
    return NextResponse.json({ error: 'Ошибка генерации протокола' }, { status: 500 })
  }
}
