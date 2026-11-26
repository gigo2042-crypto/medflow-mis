// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { describe, expect, it } from 'vitest'
import { buildProtocolPrompt, fallbackProtocol, icdByCode, pseudonymize, validateProtocol } from '@/lib/ai-protocol'

const GOOD = (code: string, name = 'что-то') => [
  'Жалобы: боль в зубе при накусывании.',
  'Анамнез: болеет три дня.',
  'Объективно: кариозная полость, перкуссия безболезненна.',
  `Диагноз (МКБ-10): ${code} ${name}`,
  'План лечения: лечение кариеса, контроль через полгода.',
].join('\n')

describe('ИИ-протокол', () => {
  it('промпт: системное сообщение, справочник МКБ, без ФИО', () => {
    const p = buildProtocolPrompt({ complaints: 'Иванов жалуется на боль, тел. +7 999 123-45-67', diagnosisCode: 'K02.1', patientNames: ['Иванов'] })
    expect(p.icd?.code).toBe('K02.1')
    expect(p.system.length).toBeGreaterThan(20)
    expect(p.user).toContain('K02.1')
    expect(p.user).not.toContain('Иванов')
    expect(p.user).not.toContain('123-45-67')
  })
  it('анамнез необязателен', () => {
    const text = fallbackProtocol({ complaints: 'боль', diagnosisCode: 'K02.1' })
    expect(text).toContain('Анамнез: не указан')
    expect(validateProtocol(text, icdByCode('K02.1')).ok).toBe(true)
  })
  it('валидация: чужой код МКБ отклоняется, название диагноза — из справочника', () => {
    const icd = icdByCode('K02.1')!
    expect(validateProtocol(GOOD('J06.9'), icd)).toMatchObject({ ok: false })
    const ok = validateProtocol(GOOD('K02.1', 'выдуманное название'), icd)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.protocol).toContain(`K02.1 ${icd.name}`)
  })
  it('валидация: латиница и пропущенный раздел отклоняются', () => {
    expect(validateProtocol('Complaints: tooth pain for three days, examination shows caries, plan: filling', null).ok).toBe(false)
    expect(validateProtocol(GOOD('K02.1').replace(/План лечения:.*/, ''), icdByCode('K02.1')).ok).toBe(false)
  })
  it('псевдонимизация: ФИО, телефон, e-mail, карта, СНИЛС', () => {
    const s = pseudonymize('Петрова Анна, +7 (916) 555-12-34, anna@mail.example, карта MF-000123, СНИЛС 123-456-789 01', ['Петрова', 'Анна'])
    expect(s).not.toMatch(/Петрова|Анна|555-12-34|anna@mail|MF-000123|123-456-789/)
  })
})
