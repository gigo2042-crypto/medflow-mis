// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Доступ к разделам отчётности по ролям и белый список доменов для рассылки отчётов (чеклист п.6)
import type { Role } from '@/lib/rbac'

export type ReportSection = 'operations' | 'marketing' | 'patients' | 'compliance' | 'finance' | 'stock' | 'staff' | 'predictive'

export const ALL_SECTIONS: ReportSection[] = ['operations', 'marketing', 'patients', 'compliance', 'finance', 'stock', 'staff', 'predictive']

export const REPORT_SECTIONS_BY_ROLE: Record<Role, ReportSection[]> = {
  ADMIN: ALL_SECTIONS,
  HEAD: ALL_SECTIONS,
  // у регистратора и врача нет права reports.read: отчётов нет (кассовая сводка — во вкладке «Касса»)
  REGISTRAR: [],
  DOCTOR: [],
  MARKETER: ['marketing', 'patients'],
}

export function reportSectionsOf(role: string): ReportSection[] {
  return REPORT_SECTIONS_BY_ROLE[role as Role] ?? []
}

export function canSeeSection(role: string, section: string): boolean {
  return reportSectionsOf(role).includes(section as ReportSection)
}

// Раздел каждого отчёта планировщика
export const SCHED_REPORT_SECTION: Record<string, ReportSection> = {
  'ОТЧ-01': 'operations',
  'ОТЧ-03': 'operations',
  'ОТЧ-24': 'stock',
  'ОТЧ-26': 'staff',
  'ОТЧ-27': 'marketing',
  CASH_DAY: 'finance',
}

/** REPORT_EMAIL_DOMAINS="clinic.example,holding.example" — куда разрешено отправлять отчёты. Пусто — никуда. */
export function allowedReportDomains(env: Record<string, string | undefined> = process.env): string[] {
  return String(env.REPORT_EMAIL_DOMAINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
}

export function isAllowedReportEmail(email: string, domains: string[]): boolean {
  const at = email.lastIndexOf('@')
  if (at < 1) return false
  const domain = email.slice(at + 1).toLowerCase()
  return domains.includes(domain)
}
