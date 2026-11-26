// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Печатная форма протокола: ключи интерактивного шаблона «Раздел||key» выводятся
// человекочитаемыми подписями (чеклист п.10), дата — дата приёма, а не печати.
import type { ProtocolTemplateDTO } from '@/lib/types'
import { ddmmyyyy } from '@/lib/mis-utils'

export function templateLabel(key: string, template: Pick<ProtocolTemplateDTO, 'sections'> | null | undefined): string {
  const [sectionTitle, itemKey] = key.split('||')
  const section = template?.sections.find((s) => s.title === sectionTitle)
  const item = section?.items.find((i) => i.key === itemKey)
  return `${sectionTitle} — ${item?.label ?? itemKey ?? ''}`
}

export interface PrintableVisit {
  patient: { lastName: string; firstName: string; middleName: string | null; cardNumber: string }
  doctor: { name: string; specialty: string }
  appointment: { start: string }
  templateData: string | null
  complaints: string | null
  diagnosisCode: string | null
  diagnosisName: string | null
  protocolText: string | null
}

export function buildProtocolPrint(
  visit: PrintableVisit,
  template: Pick<ProtocolTemplateDTO, 'sections'> | null | undefined,
  opts: { clinicLine: string; ageLine: string }
): string {
  const p = visit.patient
  const lines: string[] = [
    'ПРОТОКОЛ ПРИЁМА (форма 025/у)',
    opts.clinicLine,
    '',
    `Пациент: ${p.lastName} ${p.firstName}${p.middleName ? ' ' + p.middleName : ''} (${p.cardNumber})`,
    `Возраст: ${opts.ageLine}`,
    `Врач: ${visit.doctor.name} (${visit.doctor.specialty})`,
    `Дата приёма: ${ddmmyyyy(new Date(visit.appointment.start))}`,
    '',
  ]
  if (visit.templateData) {
    try {
      const td = JSON.parse(visit.templateData) as { chips?: Record<string, string[]>; texts?: Record<string, string> }
      const chipLines = Object.entries(td.chips || {})
        .filter(([, v]) => v.length)
        .map(([k, v]) => `${templateLabel(k, template)}: ${v.join(', ')}`)
      const textLines = Object.entries(td.texts || {})
        .filter(([, v]) => v)
        .map(([k, v]) => `${templateLabel(k, template)}: ${v}`)
      if (chipLines.length || textLines.length) lines.push('Отметки по интерактивному шаблону:', ...chipLines, ...textLines, '')
    } catch {
      // без отметок
    }
  }
  if (visit.complaints) lines.push(`Жалобы: ${visit.complaints}`, '')
  if (visit.diagnosisCode) lines.push(`Диагноз МКБ-10: ${visit.diagnosisCode} — ${visit.diagnosisName || ''}`, '')
  lines.push(visit.protocolText || '(протокол не заполнен)', '', 'Врач: ______________ / ______________ /')
  return lines.join('\n')
}
