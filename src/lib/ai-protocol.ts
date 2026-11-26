// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Подготовка запросов к LLM и проверка ответов (чеклист п.8):
// псевдонимизация, диагноз строго из справочника МКБ, валидация ответа.
import { ICD_LIST, IcdEntry } from '@/lib/icd'
import { scrubPd, type ScrubOptions } from '@/lib/pii'

export function icdByCode(code: string | null | undefined): IcdEntry | null {
  if (!code) return null
  const c = String(code).trim().toUpperCase()
  return ICD_LIST.find((e) => e.code.toUpperCase() === c) ?? null
}

/** Убирает из свободного текста ФИО пациента (во всех падежах), родственников, адреса, организации,
 *  телефоны, e-mail, номера карт и документов. Реализация — src/lib/pii.ts (общая с обезличиванием). */
export function pseudonymize(text: string, names: Array<string | null | undefined> = [], extra: Omit<ScrubOptions, 'names'> = {}): string {
  return scrubPd(text, { ...extra, names })
}

export function ageOf(birthDate: Date | null | undefined, now = new Date()): number | null {
  if (!birthDate) return null
  let a = now.getUTCFullYear() - birthDate.getUTCFullYear()
  const m = now.getUTCMonth() - birthDate.getUTCMonth()
  if (m < 0 || (m === 0 && now.getUTCDate() < birthDate.getUTCDate())) a--
  return a
}

export const PROTOCOL_SECTIONS = ['Жалобы:', 'Анамнез:', 'Объективно:', 'Диагноз (МКБ-10):', 'План лечения:']

export interface ProtocolInput {
  specialty?: string
  complaints?: string
  notes?: string
  anamnesis?: string
  selections?: Record<string, unknown>
  diagnosisCode?: string | null
  /** Диагноз, уже проверенный по справочнику в БД (иначе — встроенный список) */
  diagnosis?: IcdEntry | null
  patientNames?: Array<string | null | undefined>
  patientPhones?: Array<string | null | undefined>
  patientEmails?: Array<string | null | undefined>
}

export function buildProtocolPrompt(input: ProtocolInput): { system: string; user: string; icd: IcdEntry | null } {
  const icd = input.diagnosis !== undefined ? input.diagnosis : icdByCode(input.diagnosisCode)
  const names = input.patientNames ?? []
  const pd = { phones: input.patientPhones ?? [], emails: input.patientEmails ?? [] }
  const selLines: string[] = []
  for (const [section, items] of Object.entries(input.selections ?? {})) {
    if (Array.isArray(items) && items.length) selLines.push(`${section}: ${items.map(String).join(', ')}`)
  }
  const user = [
    input.specialty ? `Специалист: ${input.specialty}` : '',
    input.complaints ? `Краткие тезисы врача: ${pseudonymize(input.complaints, names, pd).slice(0, 1000)}` : '',
    selLines.length ? `Отметки врача в интерактивном шаблоне:\n- ${pseudonymize(selLines.join('\n- '), names, pd)}` : '',
    input.notes ? `Заметки осмотра: ${pseudonymize(input.notes, names, pd).slice(0, 1000)}` : '',
    `Анамнез: ${input.anamnesis ? pseudonymize(input.anamnesis, names, pd).slice(0, 1000) : 'не указан'}`,
    icd ? `Диагноз, выбранный врачом: ${icd.code} ${icd.name}` : 'Диагноз врачом не выбран.',
  ]
    .filter(Boolean)
    .join('\n')
  const system = [
    'Ты помогаешь врачу клиники оформить протокол приёма. Пиши только на русском языке.',
    `Строго пять разделов, каждый с новой строки: ${PROTOCOL_SECTIONS.map((s) => `"${s}"`).join(', ')}.`,
    'Используй ТОЛЬКО предоставленные данные, не придумывай симптомы, анамнез и факты.',
    'Если анамнез не указан — напиши "Анамнез: не указан".',
    icd
      ? `В разделе "Диагноз (МКБ-10):" укажи ровно "${icd.code} ${icd.name}" и никакие другие коды.`
      : 'В разделе "Диагноз (МКБ-10):" напиши "не выбран врачом" и не указывай никаких кодов.',
    'Ответ — только текст протокола, без вступлений и пояснений.',
  ].join(' ')
  return { system, user, icd }
}

const ICD_CODE_RE = /\b[A-Z]\d{2}(?:\.\d{1,2})?\b/g

/** Проверка ответа модели; при успехе — протокол с диагнозом, подставленным из справочника. */
export function validateProtocol(text: string, icd: IcdEntry | null): { ok: true; protocol: string } | { ok: false; reason: string } {
  const t = String(text || '').trim()
  if (t.length < 40 || t.length > 6000) return { ok: false, reason: 'length' }
  const letters = t.match(/\p{L}/gu) ?? []
  const cyr = t.match(/[А-Яа-яЁё]/g) ?? []
  if (letters.length === 0 || cyr.length / letters.length < 0.85) return { ok: false, reason: 'not_cyrillic' }
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const bySection = new Map<string, string>()
  let current: string | null = null
  for (const l of lines) {
    const sec = PROTOCOL_SECTIONS.find((s) => l.toLowerCase().startsWith(s.replace(' (МКБ-10)', '').replace(':', '').toLowerCase()))
    if (sec) {
      current = sec
      const rest = l.replace(/^[^:]*:\s*/, '')
      bySection.set(sec, rest)
    } else if (current) {
      bySection.set(current, `${bySection.get(current) ?? ''} ${l}`.trim())
    }
  }
  for (const s of PROTOCOL_SECTIONS) if (!bySection.has(s)) return { ok: false, reason: `missing:${s}` }
  const codes = t.match(ICD_CODE_RE) ?? []
  for (const c of codes) {
    if (!icd || c !== icd.code) return { ok: false, reason: `foreign_code:${c}` }
  }
  bySection.set('Диагноз (МКБ-10):', icd ? `${icd.code} ${icd.name}` : 'не выбран врачом')
  if (!bySection.get('Анамнез:')) bySection.set('Анамнез:', 'не указан')
  const protocol = PROTOCOL_SECTIONS.map((s) => `${s} ${bySection.get(s)}`).join('\n')
  return { ok: true, protocol }
}

export function fallbackProtocol(input: ProtocolInput, templateName?: string): string {
  const icd = input.diagnosis !== undefined ? input.diagnosis : icdByCode(input.diagnosisCode)
  const names = input.patientNames ?? []
  const sel = Object.entries(input.selections ?? {})
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([k, v]) => `${k}: ${(v as unknown[]).join(', ')}`)
    .join('; ')
  return [
    `Жалобы: ${pseudonymize(input.complaints || '', names) || sel || 'не предъявлены'}.`,
    `Анамнез: ${input.anamnesis ? pseudonymize(input.anamnesis, names) : 'не указан'}.`,
    `Объективно: ${pseudonymize(input.notes || '', names) || (templateName ? `по шаблону «${templateName}»` : 'без особенностей')}.`,
    `Диагноз (МКБ-10): ${icd ? `${icd.code} ${icd.name}` : 'не выбран врачом'}.`,
    'План лечения: по назначению врача.',
  ].join('\n')
}
