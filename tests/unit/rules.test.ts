// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { describe, expect, it } from 'vitest'
import { canReschedule, canTransition } from '@/lib/appointment-rules'
import { canSeeSection, isAllowedReportEmail, allowedReportDomains } from '@/lib/report-access'
import { matchesSegment } from '@/lib/segments'
import { hasPerm, tabsOf } from '@/lib/rbac'
import { canEditVisitOf } from '@/lib/visit-access'
import { hashPassword, passwordProblem, verifyPassword } from '@/lib/password'

describe('Статусы приёма', () => {
  it('таблица переходов', () => {
    expect(canTransition('BOOKED', 'ARRIVED')).toBe(true)
    expect(canTransition('ARRIVED', 'DONE')).toBe(true)
    expect(canTransition('BOOKED', 'DONE')).toBe(false)
    expect(canTransition('DONE', 'CANCELED')).toBe(false)
    expect(canTransition('CANCELED', 'BOOKED')).toBe(false)
    expect(canReschedule('BOOKED')).toBe(true)
    expect(canReschedule('DONE')).toBe(false)
  })
})

describe('RBAC', () => {
  it('маркетолог не видит полную карточку, но управляет рассылками', () => {
    expect(hasPerm('MARKETER', 'patients.read')).toBe(false)
    expect(hasPerm('MARKETER', 'patients.read_basic')).toBe(true)
    expect(hasPerm('MARKETER', 'campaigns.manage')).toBe(true)
    expect(tabsOf('MARKETER')).toContain('campaigns')
  })
  it('направление в лабораторию: врач и регистратура', () => {
    expect(hasPerm('DOCTOR', 'labs.create')).toBe(true)
    expect(hasPerm('MARKETER', 'labs.create')).toBe(false)
  })
  it('врач редактирует только свои визиты', () => {
    expect(canEditVisitOf({ role: 'DOCTOR', doctorId: 'd1' }, 'd1')).toBe(true)
    expect(canEditVisitOf({ role: 'DOCTOR', doctorId: 'd1' }, 'd2')).toBe(false)
    expect(canEditVisitOf({ role: 'DOCTOR', doctorId: null }, 'd2')).toBe(false)
    expect(canEditVisitOf({ role: 'REGISTRAR', doctorId: null }, 'd1')).toBe(false)
  })
  it('разделы отчётов по ролям', () => {
    expect(canSeeSection('ADMIN', 'finance')).toBe(true)
    expect(canSeeSection('DOCTOR', 'finance')).toBe(false)
  })
  it('отчёты по e-mail — только на разрешённые домены', () => {
    const d = allowedReportDomains({ REPORT_EMAIL_DOMAINS: 'clinic.example, @corp.example' })
    expect(isAllowedReportEmail('boss@clinic.example', d)).toBe(true)
    expect(isAllowedReportEmail('x@CORP.example', d)).toBe(true)
    expect(isAllowedReportEmail('leak@gmail.com', d)).toBe(false)
    expect(isAllowedReportEmail('a@clinic.example.evil.com', d)).toBe(false)
    expect(isAllowedReportEmail('any@clinic.example', [])).toBe(false)
  })
})

describe('Сегменты рассылок', () => {
  const now = new Date('2026-06-01T00:00:00Z')
  const p = { id: '1', gender: 'F', birthDate: new Date('1990-06-10T00:00:00Z'), marketingConsent: true, lastVisitAt: new Date('2025-01-01T00:00:00Z'), noShows: 0 }
  it('без согласия на рассылки пациент не попадает ни в один сегмент', () => {
    expect(matchesSegment({ ...p, marketingConsent: false }, {}, now)).toBe(false)
  })
  it('фильтры', () => {
    expect(matchesSegment(p, { gender: 'F', ageFrom: 30, ageTo: 40 }, now)).toBe(true)
    expect(matchesSegment(p, { gender: 'M' }, now)).toBe(false)
    expect(matchesSegment(p, { lastVisitMonthsMin: 6 }, now)).toBe(true)
    expect(matchesSegment(p, { birthdayInDays: 14 }, now)).toBe(true)
    expect(matchesSegment(p, { noShowMin: 1 }, now)).toBe(false)
  })
})

describe('Пароли', () => {
  it('scrypt-хэш и проверка', async () => {
    const h = await hashPassword('fake-password-123')
    expect(await verifyPassword('fake-password-123', h)).toBe(true)
    expect(await verifyPassword('wrong-password-123', h)).toBe(false)
    expect(await verifyPassword('x', null)).toBe(false)
  })
  it('политика сложности', () => {
    expect(passwordProblem('short1')).not.toBeNull()
    expect(passwordProblem('onlylettersxxxx')).not.toBeNull()
    expect(passwordProblem('letters-and-123')).toBeNull()
  })
})
