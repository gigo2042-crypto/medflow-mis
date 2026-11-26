// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Серверный движок печатных форм (ФТ-009): подстановка {{переменных}} в шаблон документа

import { ageFromBirthDate, ddmmyyyy as clinicDdmmyyyy } from '@/lib/mis-utils'
import type { ClinicRequisites } from '@/lib/clinic'

export interface DocCtx {
  patient: {
    cardNumber: string
    lastName: string
    firstName: string
    middleName: string | null
    phone: string
    birthDate: Date | null
    gender: string
  }
  doctor?: { name: string; specialty: string } | null
  visit?: { start: Date; diagnosisCode: string | null; diagnosisName: string | null; price: number } | null
  staffName: string
  /** Реквизиты клиники из env (requireClinic) — без выдуманных значений */
  clinic: Pick<ClinicRequisites, 'name' | 'address' | 'phone' | 'license' | 'inn'>
}

function ddmmyyyy(d: Date): string {
  return clinicDdmmyyyy(d)
}

export function renderTemplate(body: string, ctx: DocCtx): string {
  const p = ctx.patient
  const fullName = [p.lastName, p.firstName, p.middleName].filter(Boolean).join(' ')
  const map: Record<string, string> = {
    'patient.fullName': fullName,
    'patient.shortName': `${p.lastName} ${p.firstName.charAt(0)}.`,
    'patient.cardNumber': p.cardNumber,
    'patient.phone': p.phone,
    'patient.birthDate': p.birthDate ? ddmmyyyy(p.birthDate) : '—',
    'patient.age': p.birthDate ? ageFromBirthDate(p.birthDate.toISOString()) : '—',
    'patient.gender': p.gender === 'M' ? 'мужской' : 'женский',
    today: ddmmyyyy(new Date()),
    'clinic.name': ctx.clinic.name,
    'clinic.address': ctx.clinic.address,
    'clinic.phone': ctx.clinic.phone || '—',
    'clinic.license': ctx.clinic.license,
    'clinic.inn': ctx.clinic.inn,
    'doctor.name': ctx.doctor?.name || '—',
    'doctor.specialty': ctx.doctor?.specialty || '—',
    'visit.date': ctx.visit ? ddmmyyyy(ctx.visit.start) : '—',
    'visit.diagnosis': ctx.visit?.diagnosisCode ? `${ctx.visit.diagnosisCode} — ${ctx.visit.diagnosisName || ''}`.trim() : '—',
    'visit.price': ctx.visit ? `${ctx.visit.price} руб.` : '—',
    'staff.name': ctx.staffName,
  }
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (raw, key: string) => map[key] ?? raw)
}
