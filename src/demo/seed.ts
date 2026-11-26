// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Демо-данные MedFlow. Используется ТОЛЬКО в демо-режиме: CLI `npm run demo:seed`
// и кнопка/ежедневный сброс /api/demo/reset. В production-образ не попадает.
import { DEMO_PD_CONSENT_TEXT, PD_CONSENT_TEMPLATE } from '../lib/consent-text'
import type { PrismaClient } from '@prisma/client'
import { randomBytes, scryptSync } from 'crypto'
import { addDaysKey, clinicMinutes, ddmm, parseDateKey, timeStr, todayKey, zonedTime } from '../lib/mis-utils'
import { computeNextRunAt } from '../lib/reports-run'
import { DOC_TEMPLATES, NOTIFICATION_TEMPLATES, PROTOCOL_TEMPLATES } from '../reference/data'
import { patientLink } from '../lib/patient-links'

const rnd = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min
const pick = <T,>(arr: T[]): T => arr[rnd(0, arr.length - 1)]


// scrypt с солью — тот же алгоритм, что и в lib/auth-server.ts (РД-017)
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`
}

// Момент «день dayOffset от сегодня, hh:mm» в часовом поясе клиники
function at(dayOffset: number, hour: number, minute = 0): Date {
  const k = parseDateKey(addDaysKey(todayKey(), dayOffset))!
  return zonedTime(k.y, k.m, k.d, hour, minute)
}

function roundUpToHalfHour(base: Date, addHours: number): Date | null {
  const t = Math.floor((base.getTime() + addHours * 3600 * 1000) / 60000) * 60000
  const mins = clinicMinutes(new Date(t))
  const r = new Date(t + ((30 - (mins % 30)) % 30) * 60000)
  const rm = clinicMinutes(r)
  if (rm >= 18 * 60 || rm < mins) return null
  return r
}

const DGN = {
  dental: [
    { code: 'K02.1', name: 'Кариес дентина' },
    { code: 'K04.0', name: 'Пульпит' },
    { code: 'K05.1', name: 'Гингивит' },
    { code: 'K03.6', name: 'Отложения на зубах' },
  ],
  therapy: [
    { code: 'J06.9', name: 'Острая инфекция верхних дыхательных путей неуточнённая' },
    { code: 'J02.9', name: 'Фарингит' },
    { code: 'M54.9', name: 'Дорсалгия неуточнённая' },
    { code: 'K29.7', name: 'Гастрит неуточнённый' },
    { code: 'Z00.0', name: 'Общий медицинский осмотр' },
  ],
}

const COMPLAINTS = {
  dental: ['Боль в зубе при накусывании', 'Кровоточивость дёсен при чистке', 'Чувствительность к холодному', 'Скол переднего зуба'],
  therapy: ['Головная боль 3 дня', 'Температура 37,8 и кашель', 'Боль в горле при глотании', 'Дискомфорт в животе после еды'],
}

const SERVICES: Array<{ name: string; category: string; price: number; durationMinutes: number }> = [
  { name: 'Консультация стоматолога', category: 'Стоматология · Терапия', price: 1000, durationMinutes: 30 },
  { name: 'Осмотр с планом лечения', category: 'Стоматология · Терапия', price: 1500, durationMinutes: 30 },
  { name: 'Профессиональная гигиена полости рта', category: 'Стоматология · Терапия', price: 4500, durationMinutes: 60 },
  { name: 'Лечение кариеса: постановка пломбы', category: 'Стоматология · Терапия', price: 3500, durationMinutes: 45 },
  { name: 'Лечение пульпита: 1 канал', category: 'Стоматология · Терапия', price: 7000, durationMinutes: 60 },
  { name: 'Удаление зуба', category: 'Стоматология · Хирургия', price: 3000, durationMinutes: 40 },
  { name: 'Сложное удаление зуба мудрости', category: 'Стоматология · Хирургия', price: 6000, durationMinutes: 60 },
  { name: 'Коронка из диоксида циркония', category: 'Стоматология · Ортопедия', price: 18000, durationMinutes: 60 },
  { name: 'Имплантация: установка импланта', category: 'Стоматология · Ортопедия', price: 45000, durationMinutes: 90 },
  { name: 'Первичный приём терапевта', category: 'Терапия', price: 2000, durationMinutes: 30 },
  { name: 'Повторный приём терапевта', category: 'Терапия', price: 1500, durationMinutes: 30 },
  { name: 'ЭКГ с расшифровкой', category: 'Терапия', price: 1200, durationMinutes: 15 },
  { name: 'Забор крови из вены', category: 'Терапия', price: 500, durationMinutes: 10 },
  { name: 'Приём педиатра первичный', category: 'Педиатрия', price: 2200, durationMinutes: 30 },
  { name: 'Приём педиатра повторный', category: 'Педиатрия', price: 1700, durationMinutes: 30 },
]


export interface DemoSeedOptions {
  password: string
  ssoIssuer?: string
  log?: (msg: string) => void
}

export async function seedDemo(db: PrismaClient, opts: DemoSeedOptions) {
  const DEMO_PASSWORD = opts.password
  const log = opts.log ?? ((m: string) => console.log(m))
  log('Seeding MedFlow demo data...')

  await db.campaign.deleteMany()
  await db.segment.deleteMany()
  await db.reminderRule.deleteMany()
  await db.rateLimit.deleteMany()
  // журнал аудита неизменяем (триггер БД); сброс демо — явное обслуживание в одной транзакции
  await db.$transaction([db.$executeRaw`SELECT set_config('medflow.audit_maintenance', 'on', true)`, db.auditLog.deleteMany()])
  await db.pendingLogin.deleteMany()
  await db.authSession.deleteMany()
  await db.signedDocument.deleteMany()
  await db.payment.deleteMany()
  await db.serviceItem.deleteMany()
  await db.documentTemplate.deleteMany()
  await db.workSession.deleteMany()
  await db.widgetDraft.deleteMany()
  await db.reminder.deleteMany()
  await db.consentRecord.deleteMany()
  await db.notification.deleteMany()
  await db.notificationTemplate.deleteMany()
  await db.notificationBlacklist.deleteMany()
  await db.notificationSetting.deleteMany()
  await db.egiszDocument.deleteMany()
  await db.integrationEvent.deleteMany()
  await db.labReferral.deleteMany()
  await db.dmsClaim.deleteMany()
  await db.insurancePolicy.deleteMany()
  await db.callEvent.deleteMany()
  await db.reportRun.deleteMany()
  await db.reportSchedule.deleteMany()
  await db.oneCExport.deleteMany()
  await db.inventoryLine.deleteMany()
  await db.inventoryAct.deleteMany()
  await db.transferLine.deleteMany()
  await db.transferDoc.deleteMany()
  await db.stockBalance.deleteMany()
  await db.warehouse.deleteMany()
  await db.stockMovement.deleteMany()
  await db.stockItem.deleteMany()
  await db.waitingListEntry.deleteMany()
  await db.visit.deleteMany()
  await db.appointment.deleteMany()
  await db.protocolTemplate.deleteMany()
  await db.staffUser.deleteMany()
  await db.patient.deleteMany()
  await db.doctor.deleteMany()

  // ---------- Врачи ----------
  const dentist = await db.doctor.create({ data: { name: 'Иванова Анна Сергеевна', specialty: 'Стоматолог-терапевт', color: 'emerald', workStart: '09:00', workEnd: '18:00', slotMinutes: 30 } })
  const therapist = await db.doctor.create({ data: { name: 'Петрова Мария Ивановна', specialty: 'Терапевт', color: 'teal', workStart: '09:00', workEnd: '15:00', slotMinutes: 30 } })
  const ortho = await db.doctor.create({ data: { name: 'Смирнов Олег Викторович', specialty: 'Стоматолог-ортопед', color: 'amber', workStart: '10:00', workEnd: '19:00', slotMinutes: 60 } })
  const pediatric = await db.doctor.create({ data: { name: 'Кузнецова Ольга Петровна', specialty: 'Педиатр', color: 'rose', workStart: '09:00', workEnd: '15:00', slotMinutes: 30 } })
  const docs = [dentist, therapist, ortho, pediatric]

  // ---------- Прейскурант (ФТ-007): цены визитов берутся только отсюда ----------
  const services: Array<{ id: string; name: string; category: string; price: number }> = []
  for (const s of SERVICES) {
    const created = await db.serviceItem.create({ data: s })
    services.push(created)
  }
  const servicesFor = (specialty: string) => {
    const sp = specialty.toLowerCase()
    const cat = sp.includes('стоматолог') ? 'Стоматология' : sp.includes('педиатр') ? 'Педиатрия' : 'Терапия'
    return services.filter((x) => x.category.startsWith(cat))
  }

  // ---------- Правила каскада напоминаний ----------
  for (const r of [{ level: 1, hours: 48 }, { level: 2, hours: 24 }, { level: 3, hours: 3 }]) {
    await db.reminderRule.create({ data: r })
  }

  // ---------- Пациенты ----------
  const patientsData: Array<[string, string, string, string, number, string]> = [
    ['Соколова', 'Елена', 'Викторовна', '+7 900 555-01-01', 1985, 'F'],
    ['Волков', 'Дмитрий', 'Александрович', '+7 900 555-01-02', 1978, 'M'],
    ['Кравцова', 'Наталья', 'Игоревна', '+7 900 555-01-03', 1992, 'F'],
    ['Морозов', 'Александр', 'Петрович', '+7 900 555-01-04', 1969, 'M'],
    ['Лебедева', 'Ольга', 'Николаевна', '+7 900 555-01-05', 2001, 'F'],
    ['Новиков', 'Сергей', 'Владимирович', '+7 900 555-01-06', 1987, 'M'],
    ['Фёдорова', 'Анна', 'Дмитриевна', '+7 900 555-01-07', 1996, 'F'],
    ['Гусев', 'Игорь', 'Олегович', '+7 900 555-01-08', 1975, 'M'],
    ['Романова', 'Мария', 'Андреевна', '+7 900 555-01-09', 1999, 'F'],
    ['Зайцев', 'Павел', 'Николаевич', '+7 900 555-01-10', 1982, 'M'],
    ['Беляева', 'Ксения', 'Сергеевна', '+7 900 555-01-11', 1994, 'F'],
    ['Титов', 'Артём', 'Валерьевич', '+7 900 555-01-12', 2013, 'M'],
  ]

  const PATIENT_EMAILS = ['sokolova', 'volkov', 'kravtsova', 'morozov', 'lebedeva', 'novikov', 'fedorova', 'gusev', 'romanova', 'zaitsev', 'belyaeva', 'titov']

  const patients: Array<Awaited<ReturnType<PrismaClient['patient']['create']>>> = []
  for (let i = 0; i < patientsData.length; i++) {
    const [ln, fn, mn, phone, year, gender] = patientsData[i]
    const p = await db.patient.create({
      data: {
        cardNumber: `MF-${1001 + i}`,
        lastName: ln,
        firstName: fn,
        middleName: mn,
        phone,
        email: `${PATIENT_EMAILS[i]}@mail.demo`, // транзакционные письма (ИНТ-014)
        gender,
        birthDate: new Date(Date.UTC(year, rnd(0, 11), rnd(1, 28))),
        marketingConsent: i % 3 !== 0, // согласие на рекламные рассылки — у части пациентов
        marketingConsentAt: new Date(Date.now() - 30 * 86400_000),
        pdConsentAt: new Date(Date.now() - 30 * 86400_000),
        pdConsentVersion: 'demo-1',
        pdConsentSource: 'PAPER',
        notes: i === 3 ? 'Повышенное давление, принимает гипотензивные' : null,
        // демо: часть пациентов подключила бота MAX (фейковые user_id, наружу ничего не уходит)
        maxUserId: i % 4 === 1 ? String(900000000 + i) : null,
        maxLinkedAt: i % 4 === 1 ? new Date(Date.now() - 20 * 86400_000) : null,
      },
    })
    patients.push(p)
  }
  // фиксированные номера демо-карт → последовательность нумерации на максимум (новые карты — дальше)
  // (тот же SQL, что syncCardSequence в lib/patients.ts; сид импортирует только относительные модули)
  await db.$queryRaw`SELECT setval('patient_card_seq', GREATEST(1000, COALESCE((
    SELECT MAX(CAST(SUBSTRING("cardNumber" FROM 4) AS BIGINT)) FROM "Patient" WHERE "cardNumber" ~ '^MF-[0-9]+$'
  ), 1000)), true)`

  // ---------- Интерактивные шаблоны протоколов (точка улучшения №2) ----------
  const therapyTemplate = await db.protocolTemplate.create({ data: PROTOCOL_TEMPLATES[0] })
  const dentalTemplate = await db.protocolTemplate.create({ data: PROTOCOL_TEMPLATES[1] })

  // ---------- История за 14 дней ----------
  let created = 0
  for (let off = -14; off <= -1; off++) {
    for (const doc of docs) {
      const n = rnd(2, 5)
      const used = new Set<number>()
      const [sh] = doc.workStart.split(':').map(Number)
      const [eh] = doc.workEnd.split(':').map(Number)
      const slotCount = Math.floor(((eh - sh) * 60) / doc.slotMinutes)
      for (let i = 0; i < n; i++) {
        let idx = rnd(0, slotCount - 1)
        let guard = 0
        while (used.has(idx) && guard++ < 20) idx = rnd(0, slotCount - 1)
        if (used.has(idx)) continue
        used.add(idx)
        const start = at(off, sh, idx * doc.slotMinutes)
        const roll = Math.random()
        const status = roll < 0.82 ? 'DONE' : roll < 0.9 ? 'NO_SHOW' : 'CANCELED'
        const patient = pick(patients)
        const source = Math.random() < 0.18 ? 'WIDGET' : Math.random() < 0.35 ? 'PHONE' : 'REGISTRAR'
        try {
          const appt = await db.appointment.create({
            data: { patientId: patient.id, doctorId: doc.id, start, status, source, duration: doc.slotMinutes },
          })
          created++
          if (status === 'DONE') {
            const kind = doc.specialty.includes('Стоматолог') ? 'dental' : 'therapy'
            const d = pick(DGN[kind])
            const svc = pick(servicesFor(doc.specialty))
            await db.visit.create({
              data: {
                appointmentId: appt.id,
                patientId: appt.patientId,
                doctorId: doc.id,
                complaints: pick(COMPLAINTS[kind]),
                diagnosisCode: d.code,
                diagnosisName: d.name,
                protocolText: `Осмотр проведён. ${pick(COMPLAINTS[kind])}. Объективно: по данным осмотра выставлен диагноз. План лечения согласован с пациентом.`,
                serviceId: svc.id,
                price: svc.price,
                createdAt: start,
              },
            })
          }
        } catch {
          // дубликат слота — пропускаем
        }
      }
    }
  }

  // Гарантированные неявки для демонстрации риска no-show (точка улучшения №4)
  const noShowPatients = [patients[3], patients[7], patients[9]]
  const noShowDays = [-3, -7, -10, -12]
  for (const p of noShowPatients) {
    for (const off of noShowDays.slice(0, 2)) {
      try {
        await db.appointment.create({
          data: { patientId: p.id, doctorId: therapist.id, start: at(off, rnd(9, 13), 0), status: 'NO_SHOW', source: 'PHONE', duration: 30 },
        })
      } catch {
        // пропускаем дубликаты
      }
    }
  }

  // ---------- Сегодняшнее расписание ----------
  const now = Date.now()
  const todayPlan: Array<{ doc: typeof dentist; h: number; m: number; source: string; patient: (typeof patients)[number] }> = [
    { doc: dentist, h: 9, m: 0, source: 'WIDGET', patient: patients[0] },
    { doc: dentist, h: 10, m: 0, source: 'REGISTRAR', patient: patients[4] },
    { doc: dentist, h: 11, m: 0, source: 'REGISTRAR', patient: patients[2] },
    { doc: dentist, h: 14, m: 0, source: 'PHONE', patient: patients[3] },
    { doc: therapist, h: 9, m: 0, source: 'REGISTRAR', patient: patients[6] },
    { doc: therapist, h: 11, m: 0, source: 'WIDGET', patient: patients[10] },
    { doc: therapist, h: 13, m: 0, source: 'PHONE', patient: patients[7] },
    { doc: ortho, h: 12, m: 0, source: 'REGISTRAR', patient: patients[8] },
    { doc: pediatric, h: 10, m: 0, source: 'WIDGET', patient: patients[11] },
    { doc: pediatric, h: 11, m: 30, source: 'REGISTRAR', patient: patients[9] },
  ]
  const todayDoneVisits: Array<{ visitId: string; patientId: string; price: number; kind: string; serviceName: string }> = []
  for (const item of todayPlan) {
    const start = at(0, item.h, item.m)
    const isPast = start.getTime() < now
    try {
      const appt = await db.appointment.create({
        data: {
          patientId: item.patient.id,
          doctorId: item.doc.id,
          start,
          status: isPast ? 'DONE' : 'BOOKED',
          source: item.source,
          duration: item.doc.slotMinutes,
        },
      })
      if (isPast) {
        const kind = item.doc.specialty.includes('Стоматолог') ? 'dental' : 'therapy'
        const d = pick(DGN[kind])
        const svc = pick(servicesFor(item.doc.specialty))
        const visit = await db.visit.create({
          data: {
            appointmentId: appt.id,
            patientId: appt.patientId,
            doctorId: item.doc.id,
            complaints: pick(COMPLAINTS[kind]),
            diagnosisCode: d.code,
            diagnosisName: d.name,
            protocolText: 'Приём завершён. Протокол составлен по шаблону клиники.',
            serviceId: svc.id,
            price: svc.price,
            createdAt: start,
          },
        })
        todayDoneVisits.push({ visitId: visit.id, patientId: appt.patientId, price: visit.price, kind, serviceName: svc.name })
      }
    } catch {
      // дубликат — пропускаем
    }
  }

  // Ближайшие слоты относительно текущего времени (для списка «ожидают приёма»)
  const upcoming = [roundUpToHalfHour(new Date(), 2), roundUpToHalfHour(new Date(), 3)]
  const upcomingSources = ['WIDGET', 'PHONE']
  for (let i = 0; i < upcoming.length; i++) {
    const st = upcoming[i]
    if (!st) continue
    try {
      await db.appointment.create({
        data: { patientId: patients[1 + i].id, doctorId: i === 0 ? dentist.id : pediatric.id, start: st, status: 'BOOKED', source: upcomingSources[i], duration: 30 },
      })
    } catch {
      // дубликат — пропускаем
    }
  }
  // Завтрашний день: записи для каскада напоминаний и сценария переноса (стенд показывают в любое время суток)
  const tomorrowPlan: Array<{ doc: typeof dentist; h: number; m: number; source: string; patient: (typeof patients)[number] }> = [
    { doc: dentist, h: 9, m: 30, source: 'REGISTRAR', patient: patients[5] },
    { doc: dentist, h: 12, m: 0, source: 'WIDGET', patient: patients[6] },
    { doc: therapist, h: 10, m: 0, source: 'PHONE', patient: patients[2] },
    { doc: therapist, h: 15, m: 0, source: 'REGISTRAR', patient: patients[4] },
    { doc: pediatric, h: 11, m: 0, source: 'WIDGET', patient: patients[11] },
    { doc: ortho, h: 13, m: 0, source: 'REGISTRAR', patient: patients[8] },
  ]
  for (const item of tomorrowPlan) {
    try {
      await db.appointment.create({
        data: { patientId: item.patient.id, doctorId: item.doc.id, start: at(1, item.h, item.m), status: 'BOOKED', source: item.source, duration: item.doc.slotMinutes },
      })
    } catch {
      // дубликат — пропускаем
    }
  }

  log(`History created: ${created}, today plan: ${todayPlan.length}, today done visits: ${todayDoneVisits.length}`)

  // ---------- Сотрудники с логинами и паролями (RBAC, РД-015..017) ----------
  const staff: Array<{ login: string; name: string; role: string; phone: string; email: string; doctorId?: string; ssoSubject?: string }> = [
    { login: 'admin', name: 'Ольга Шестакова', role: 'ADMIN', phone: '+7 495 100-20-40', email: 'admin@medflow.demo' },
    { login: 'reg1', name: 'Ирина Мельник', role: 'REGISTRAR', phone: '+7 495 100-20-41', email: 'reg1@medflow.demo' },
    { login: 'reg2', name: 'Павел Зуев', role: 'REGISTRAR', phone: '+7 495 100-20-42', email: 'reg2@medflow.demo' },
    { login: 'doc1', name: 'Анна Иванова', role: 'DOCTOR', phone: '+7 495 100-20-43', email: 'doc1@medflow.demo', doctorId: dentist.id },
    { login: 'doc2', name: 'Мария Петрова', role: 'DOCTOR', phone: '+7 495 100-20-44', email: 'doc2@medflow.demo', doctorId: therapist.id },
    { login: 'mkt', name: 'Светлана Ким', role: 'MARKETER', phone: '+7 495 100-20-45', email: 'mkt@medflow.demo' },
    { login: 'head', name: 'Дмитрий Ларин', role: 'HEAD', phone: '+7 495 100-20-46', email: 'head@medflow.demo' },
    // Корпоративный вход через SSO (ИНТ-013): сопоставление ssoSubject ↔ IdP ClinicCorp ID (:3041)
    { login: 'corp1', name: 'Иванова Анна · SSO', role: 'REGISTRAR', phone: '+7 495 100-20-47', email: 'anna@clinic-corp.example', ssoSubject: `${opts.ssoIssuer ?? 'demo-idp'}|anna@clinic-corp.example` },
    { login: 'corp2', name: 'Волков Дмитрий · SSO', role: 'HEAD', phone: '+7 495 100-20-48', email: 'dmitry@holding.example', ssoSubject: `${opts.ssoIssuer ?? 'demo-idp'}|dmitry@holding.example` },
  ]
  const users: Array<Awaited<ReturnType<PrismaClient['staffUser']['create']>>> = []
  for (const s of staff) {
    const u = await db.staffUser.create({ data: { ...s, passwordHash: hashPassword(DEMO_PASSWORD) } })
    users.push(u)
  }

  await db.workSession.create({ data: { userId: users[1].id, device: 'web · регистратура', lastActivity: new Date(now - 40 * 1000), startedAt: new Date(now - 3 * 3600 * 1000) } })
  await db.workSession.create({ data: { userId: users[2].id, device: 'планшет · регистратура', lastActivity: new Date(now - 45 * 60 * 1000), startedAt: new Date(now - 5 * 3600 * 1000) } })
  await db.workSession.create({ data: { userId: users[0].id, device: 'web · кабинет администратора', lastActivity: new Date(now - 90 * 1000), startedAt: new Date(now - 2 * 3600 * 1000) } })


  // ---------- Шаблоны печатных форм (ФТ-009) ----------
  const docTemplates: Record<string, { id: string; name: string }> = {}
  for (const t of DOC_TEMPLATES) {
    const created = await db.documentTemplate.create({ data: t })
    docTemplates[t.code] = { id: created.id, name: created.name }
  }
  // Текст согласия для онлайн-записи — демо, явно помечен как не юридический
  await db.documentTemplate.create({
    data: { code: PD_CONSENT_TEMPLATE, name: 'Согласие на обработку ПДн (онлайн-запись) — ДЕМО', kind: 'CONSENT', body: DEMO_PD_CONSENT_TEXT },
  })

  // ---------- Касса: оплаты и чеки за сегодня (ФТ-006, 54-ФЗ) ----------
  const paymentIds: string[] = []
  for (let i = 0; i < Math.min(4, todayDoneVisits.length); i++) {
    const v = todayDoneVisits[i]
    const serviceName = v.serviceName
    const fiscalIssued = i < 3
    const payment = await db.payment.create({
      data: {
        patientId: v.patientId,
        visitId: v.visitId,
        amount: v.price,
        method: pick(['CARD', 'CASH', 'SBP']),
        type: 'PAYMENT',
        status: 'PAID',
        fiscalStatus: fiscalIssued ? 'ISSUED' : 'QUEUED',
        fiscalNumber: fiscalIssued ? `ФН 9928-44 · ФД ${200001 + i}` : null,
        fiscalAt: fiscalIssued ? new Date(now - (30 - i * 8) * 60 * 1000) : null,
        itemsJson: JSON.stringify([{ name: serviceName, price: v.price, qty: 1 }]),
        createdById: users[1].id,
        createdAt: new Date(now - (35 - i * 9) * 60 * 1000),
      },
    })
    paymentIds.push(payment.id)
  }
  // Возврат по первой оплате (чек возврата)
  if (paymentIds[0]) {
    const original = await db.payment.findUnique({ where: { id: paymentIds[0] } })
    if (original) {
      await db.payment.create({
        data: {
          patientId: original.patientId,
          visitId: original.visitId,
          amount: -original.amount,
          method: original.method,
          type: 'REFUND',
          status: 'PAID',
          fiscalStatus: 'ISSUED',
          fiscalNumber: `ФН 9928-44 · ФД ${200100}`,
          fiscalAt: new Date(now - 12 * 60 * 1000),
          itemsJson: original.itemsJson,
          note: `Возврат по оплате ${original.id.slice(-8).toUpperCase()}`,
          refundOfId: original.id,
          createdById: users[0].id,
          createdAt: new Date(now - 12 * 60 * 1000),
        },
      })
      await db.payment.update({ where: { id: original.id }, data: { status: 'CANCELED' } })
    }
  }

  // ---------- Подписанные документы пациентов (ФТ-009, ФТ-054) ----------
  const docVisit0 = todayDoneVisits[0]
  const docVisit1 = todayDoneVisits[1]
  if (docVisit0 && docTemplates['CONSENT_MED'] && docTemplates['CONSENT_PD']) {
    await db.signedDocument.create({
      data: {
        patientId: docVisit0.patientId,
        templateId: docTemplates['CONSENT_MED'].id,
        visitId: docVisit0.visitId,
        title: docTemplates['CONSENT_MED'].name,
        content: 'ИНФОРМИРОВАННОЕ ДОБРОВОЛЬНОЕ СОГЛАСИЕ НА МЕДИЦИНСКОЕ ВМЕШАТЕЛЬСТВО (подписано в демо-стенде)',
        signed: true,
        signedAt: new Date(now - 28 * 60 * 1000),
        createdById: users[1].id,
        createdAt: new Date(now - 28 * 60 * 1000),
      },
    })
    await db.signedDocument.create({
      data: {
        patientId: docVisit0.patientId,
        templateId: docTemplates['CONSENT_PD'].id,
        title: docTemplates['CONSENT_PD'].name,
        content: 'СОГЛАСИЕ НА ОБРАБОТКУ ПЕРСОНАЛЬНЫХ ДАННЫХ (152-ФЗ) (подписано в демо-стенде)',
        signed: true,
        signedAt: new Date(now - 27 * 60 * 1000),
        createdById: users[1].id,
        createdAt: new Date(now - 27 * 60 * 1000),
      },
    })
  }
  if (docVisit1 && docTemplates['CONTRACT']) {
    await db.signedDocument.create({
      data: {
        patientId: docVisit1.patientId,
        templateId: docTemplates['CONTRACT'].id,
        title: docTemplates['CONTRACT'].name,
        content: 'ДОГОВОР ВОЗМЕЗДНОГО ОКАЗАНИЯ УСЛУГ (подписан в демо-стенде)',
        signed: true,
        signedAt: new Date(now - 22 * 60 * 1000),
        createdById: users[1].id,
        createdAt: new Date(now - 22 * 60 * 1000),
      },
    })
  }

  // ---------- Лист ожидания (ФТ-004, ТУ-004) ----------
  const serviceBy = (n: string) => services.find((s) => s.name === n)?.id ?? null
  const waitingSeed: Array<{
    p: (typeof patients)[number]
    doctor: typeof dentist | null
    specialty: string | null
    daysMask: string
    fromTime: string
    toTime: string
    priority: number
    comment: string | null
    serviceId?: string | null
    status?: string
  }> = [
    { p: patients[5], doctor: dentist, specialty: null, daysMask: '1111111', fromTime: '09:00', toTime: '13:00', priority: 1, comment: 'Острая боль, просит максимально скоро' },
    { p: patients[4], doctor: null, specialty: 'Стоматолог-терапевт', daysMask: '1111110', fromTime: '14:00', toTime: '18:00', priority: 0, comment: null },
    { p: patients[2], doctor: therapist, specialty: null, daysMask: '1111100', fromTime: '09:00', toTime: '15:00', priority: 0, comment: null, serviceId: serviceBy('Первичный приём терапевта') },
    { p: patients[8], doctor: pediatric, specialty: null, daysMask: '1111100', fromTime: '09:00', toTime: '12:00', priority: 0, comment: 'Записываем ребёнка на утро' },
    { p: patients[7], doctor: ortho, specialty: null, daysMask: '1111100', fromTime: '10:00', toTime: '19:00', priority: 0, comment: 'Интересует имплантация, ждёт окно у ортопеда' },
  ]
  const tomorrow10 = at(1, 10, 0)
  let offeredEntryId = ''
  for (let i = 0; i < waitingSeed.length; i++) {
    const w = waitingSeed[i]
    const isOffered = i === 0
    const entry = await db.waitingListEntry.create({
      data: {
        patientId: w.p.id,
        doctorId: w.doctor?.id ?? null,
        specialty: w.specialty,
        serviceId: w.serviceId ?? null,
        daysMask: w.daysMask,
        fromTime: w.fromTime,
        toTime: w.toTime,
        priority: w.priority,
        comment: w.comment,
        status: isOffered ? 'OFFERED' : 'ACTIVE',
        // Демо автопредложения: срочная заявка уже держит слот у Ивановой на завтра 10:00
        offeredDoctorId: isOffered ? dentist.id : null,
        offeredSlot: isOffered ? tomorrow10 : null,
        offeredAt: isOffered ? new Date(now - 2 * 60 * 1000) : null,
        offerExpiresAt: isOffered ? new Date(now + 13 * 60 * 1000) : null,
        createdAt: new Date(now - (i + 1) * 3 * 3600 * 1000),
      },
    })
    if (isOffered) offeredEntryId = entry.id
  }
  // История конверсии листа ожидания (ТУ-004: ≥ 30% слотов замещается из очереди)
  let bookedAppt: { id: string } | null = null
  for (const hour of [16, 15, 17, 12]) {
    const candidate = await db.appointment.create({
      data: { patientId: patients[4].id, doctorId: dentist.id, start: at(-1, hour, 0), status: 'DONE', source: 'REGISTRAR', duration: 30 },
    }).catch(() => null)
    if (candidate) {
      bookedAppt = candidate
      break
    }
  }
  if (bookedAppt) {
    await db.waitingListEntry.create({ data: {
      patientId: patients[4].id, doctorId: dentist.id, daysMask: '1111100', fromTime: '14:00', toTime: '18:00',
      status: 'BOOKED', bookedAppointmentId: bookedAppt.id, comment: 'Записан из очереди на освободившийся слот',
      createdAt: new Date(now - 26 * 3600 * 1000),
    } })
  }
  await db.waitingListEntry.create({ data: {
    patientId: patients[9].id, doctorId: dentist.id, daysMask: '1111100', fromTime: '09:00', toTime: '13:00',
    status: 'DECLINED', comment: 'Отказался от предложенного слота', createdAt: new Date(now - 30 * 3600 * 1000),
  } })
  await db.waitingListEntry.create({ data: {
    patientId: patients[10].id, doctorId: null, specialty: 'Терапевт', daysMask: '1111100', fromTime: '09:00', toTime: '15:00',
    status: 'EXPIRED', comment: 'Не успел ответить за 15 минут — слот ушёл следующему в очереди', createdAt: new Date(now - 49 * 3600 * 1000),
  } })

  // ---------- Каскады напоминаний (ФТ-005, ТУ-004) ----------
  const futureAppts = await db.appointment.findMany({
    where: { start: { gt: new Date(now) }, status: 'BOOKED' },
    include: { patient: true, doctor: true },
    orderBy: { start: 'asc' },
    take: 12,
  })
  const CASCADE_H = (await db.reminderRule.findMany({ orderBy: { level: 'asc' } })).map((r) => r.hours)
  let remCreated = 0
  for (let i = 0; i < futureAppts.length; i++) {
    const a = futureAppts[i]
    for (let li = 0; li < CASCADE_H.length; li++) {
      const plannedAt = new Date(a.start.getTime() - CASCADE_H[li] * 3600_000)
      const isPast = plannedAt.getTime() < now
      const isFailed = i === futureAppts.length - 1 && li === 0 // демо ошибки отправки
      const text = `Уважаемый(ая) ${a.patient.firstName}! Напоминаем о приёме: ${a.doctor.name}, ${ddmm(a.start)} в ${timeStr(a.start)}, Демо-клиника. Подтвердить или отменить: ${patientLink('ap', a.id)}`
      await db.reminder.create({
        data: {
          appointmentId: a.id,
          level: li + 1,
          channel: a.patient.maxUserId ? 'MAX' : 'SMS',
          plannedAt,
          status: isFailed ? 'FAILED' : isPast ? 'SENT' : 'PLANNED',
          sentAt: isFailed || isPast ? plannedAt : null,
          text,
        },
      })
      remCreated++
    }
  }
  // Первый пациент уже подтвердил по SMS «1» — приём CONFIRMED (ФТ-005)
  if (futureAppts[0]) {
    await db.appointment.update({ where: { id: futureAppts[0].id }, data: { status: 'CONFIRMED' } })
    const sentOne = await db.reminder.findFirst({
      where: { appointmentId: futureAppts[0].id, status: 'SENT' },
      orderBy: { level: 'desc' },
    })
    if (sentOne) {
      await db.reminder.update({
        where: { id: sentOne.id },
        data: { response: 'CONFIRMED', respondedAt: new Date(now - 20 * 60 * 1000) },
      })
    }
  }
  log(`Reminders created: ${remCreated} for ${futureAppts.length} future appointments; waiting entries seeded`)

  // ---------- Центр уведомлений (ФТ-013) ----------
  const digits = (s: string) => s.replace(/\D/g, '')
  await db.notificationSetting.create({
    data: { id: 'main', quietFrom: '21:00', quietTo: '09:00', dailyLimit: 500, retryMinutes: 5, maxAttempts: 3 },
  })

  // Шаблоны сообщений (ФТ-013): тексты каскада, приглашений и касаний
  const TEMPLATES = NOTIFICATION_TEMPLATES
  for (const t of TEMPLATES) {
    await db.notificationTemplate.create({ data: t })
  }

  // Чёрный список: пациент отказался от рассылок (ФТ-013)
  await db.notificationBlacklist.create({
    data: {
      phone: digits(patients[9].phone),
      patientId: patients[9].id,
      reason: 'Письменный отказ от рассылок (152-ФЗ)',
    },
  })

  // Журнал доставки: отправленные напоминания прошли через центр (ФТ-013)
  let notifCreated = 0
  const sentReminders = await db.reminder.findMany({
    where: { status: 'SENT', appointment: { patientId: { not: patients[9].id } } },
    orderBy: { plannedAt: 'desc' },
    take: 6,
    include: { appointment: { include: { patient: true } } },
  })
  for (const r of sentReminders) {
    const p = r.appointment.patient
    await db.notification.create({
      data: {
        kind: 'REMINDER',
        channel: r.channel,
        patientId: p.id,
        patientName: `${p.lastName} ${p.firstName}`,
        phone: p.phone,
        text: r.text ?? '',
        status: 'SENT',
        attempts: 1,
        maxAttempts: 3,
        nextAttemptAt: r.plannedAt,
        sentAt: r.sentAt ?? r.plannedAt,
        relatedAppointmentId: r.appointmentId,
        relatedReminderId: r.id,
        createdAt: r.plannedAt,
      },
    })
    notifCreated++
  }

  // Доставка не удалась: канал недоступен, попытки исчерпаны (ФТ-013)
  const failedRem = await db.reminder.findFirst({
    where: { status: 'FAILED' },
    include: { appointment: { include: { patient: true } } },
  })
  if (failedRem) {
    const p = failedRem.appointment.patient
    await db.notification.create({
      data: {
        kind: 'REMINDER',
        channel: failedRem.channel,
        patientId: p.id,
        patientName: `${p.lastName} ${p.firstName}`,
        phone: p.phone,
        text: failedRem.text ?? '',
        status: 'FAILED',
        attempts: 3,
        maxAttempts: 3,
        nextAttemptAt: failedRem.plannedAt,
        error: 'Канал недоступен: попытки исчерпаны',
        relatedAppointmentId: failedRem.appointmentId,
        relatedReminderId: failedRem.id,
        createdAt: failedRem.plannedAt,
      },
    })
    notifCreated++
  }

  // Приглашение из листа ожидания доставлено (ТУ-004: автоприглашения через центр)
  if (offeredEntryId) {
    const w0 = waitingSeed[0]
    await db.notification.create({
      data: {
        kind: 'WAITLIST_OFFER',
        channel: 'SMS',
        priority: 1,
        patientId: w0.p.id,
        patientName: `${w0.p.lastName} ${w0.p.firstName}`,
        phone: w0.p.phone,
        text: `${w0.p.firstName}, освободилось время у врача ${dentist.name}: ${ddmm(tomorrow10)} в 10:00. Записаться или отказаться: ${offeredEntryId ? patientLink('wl', offeredEntryId) : ''} Предложение действует 15 минут.`,
        status: 'SENT',
        attempts: 1,
        maxAttempts: 3,
        nextAttemptAt: new Date(now - 2 * 60 * 1000),
        sentAt: new Date(now - 2 * 60 * 1000),
        relatedWaitingId: offeredEntryId,
        createdAt: new Date(now - 2 * 60 * 1000),
      },
    })
    notifCreated++
  }

  // Ручное поздравление (демо MANUAL, ФТ-013)
  await db.notification.create({
    data: {
      kind: 'MANUAL',
      channel: patients[2].maxUserId ? 'MAX' : 'SMS',
      patientId: patients[2].id,
      patientName: `${patients[2].lastName} ${patients[2].firstName}`,
      phone: patients[2].phone,
      text: 'С днём рождения! Подарок от демо-клиники — скидка 10% на профессиональную гигиену в этом месяце.',
      status: 'SENT',
      attempts: 1,
      maxAttempts: 3,
      nextAttemptAt: new Date(now - 26 * 3600 * 1000),
      sentAt: new Date(now - 26 * 3600 * 1000),
      createdAt: new Date(now - 26 * 3600 * 1000),
    },
  })
  notifCreated++

  // Напоминание о профилактике: стоит в очереди к отправке (демо QUEUED)
  await db.notification.create({
    data: {
      kind: 'MANUAL',
      channel: 'SMS',
      patientId: patients[6].id,
      patientName: `${patients[6].lastName} ${patients[6].firstName}`,
      phone: patients[6].phone,
      text: 'Прошло 6 месяцев после последней гигиены — пора на профилактику. Ближайшие слоты у стоматолога-терапевта уже открыты.',
      status: 'QUEUED',
      attempts: 0,
      maxAttempts: 3,
      nextAttemptAt: new Date(now - 60 * 1000),
      createdAt: new Date(now - 5 * 60 * 1000),
    },
  })
  notifCreated++

  // Транзакционное письмо (ИНТ-014): канал EMAIL уходит через email-провайдер
  await db.notification.create({
    data: {
      kind: 'REMINDER',
      channel: 'EMAIL',
      patientId: patients[0].id,
      patientName: `${patients[0].lastName} ${patients[0].firstName}`,
      phone: patients[0].email!, // для EMAIL здесь адрес получателя
      text: 'Напоминание о приёме завтра в 10:00 у стоматолога-терапевта. Подтвердить или отменить по ссылке из сообщения.',
      status: 'QUEUED',
      attempts: 0,
      maxAttempts: 3,
      nextAttemptAt: new Date(now - 30 * 1000),
      createdAt: new Date(now - 2 * 60 * 1000),
    },
  })
  notifCreated++

  // Часы тишины активны прямо сейчас → несрочное сообщение отложено до утра (ФТ-013)
  const nowMin = clinicMinutes(new Date(now))
  if (nowMin >= 21 * 60 || nowMin < 9 * 60) {
    const qEnd = at(nowMin < 9 * 60 ? 0 : 1, 9, 0)
    await db.notification.create({
      data: {
        kind: 'REMINDER',
        channel: 'SMS',
        patientId: patients[7].id,
        patientName: `${patients[7].lastName} ${patients[7].firstName}`,
        phone: patients[7].phone,
        text: 'Уважаемый(ая)! Напоминаем о приёме завтра. Демо-клиника.',
        status: 'DEFERRED_QUIET',
        attempts: 0,
        maxAttempts: 3,
        nextAttemptAt: qEnd,
        error: 'Часы тишины 21:00–09:00: отправка отложена',
        createdAt: new Date(now - 3 * 60 * 1000),
      },
    })
    notifCreated++
  }
  log(`Notification center: ${TEMPLATES.length} templates, ${notifCreated} journal rows, blacklist: 1`)

  // ---------- Склад расходных материалов (ФТ-008) ----------
  const STOCK: Array<{ sku: string; name: string; category: string; unit: string; qty: number; minQty: number; price: number }> = [
    { sku: 'STK-001', name: 'Перчатки нитриловые, размер M', category: 'Расходные материалы', unit: 'шт', qty: 850, minQty: 200, price: 12 },
    { sku: 'STK-002', name: 'Анестетик Ultracain D-S 1.7 мл', category: 'Медикаменты', unit: 'картр.', qty: 120, minQty: 50, price: 240 },
    { sku: 'STK-003', name: 'Пломбировочный материал композитный', category: 'Расходные материалы', unit: 'уп.', qty: 64, minQty: 20, price: 890 },
    { sku: 'STK-004', name: 'Салфетки для дентальной изоляции', category: 'Расходные материалы', unit: 'шт', qty: 15, minQty: 50, price: 9 },
    { sku: 'STK-005', name: 'Оттискной материал A-силикон', category: 'Расходные материалы', unit: 'уп.', qty: 38, minQty: 15, price: 1250 },
    { sku: 'STK-006', name: 'Иглы инъекционные 27G', category: 'Расходные материалы', unit: 'шт', qty: 400, minQty: 100, price: 7 },
    { sku: 'STK-007', name: 'Шовный материал рассасывающийся', category: 'Медикаменты', unit: 'уп.', qty: 45, minQty: 12, price: 430 },
    { sku: 'STK-008', name: 'Спиртовые салфетки', category: 'Расходные материалы', unit: 'шт', qty: 320, minQty: 80, price: 6 },
    { sku: 'STK-009', name: 'Бахилы одноразовые', category: 'Хозрасходы', unit: 'пара', qty: 600, minQty: 150, price: 4 },
    { sku: 'STK-010', name: 'Рентген-плёнка (визиограф, гибкая)', category: 'Расходные материалы', unit: 'шт', qty: 90, minQty: 30, price: 55 },
  ]
  const stockItems: Record<string, string> = {}
  for (const s of STOCK) {
    const item = await db.stockItem.create({ data: s })
    stockItems[s.sku] = item.id
  }
  // Приходы за последние 2 недели
  let stockMov = 0
  for (const [sku, id] of Object.entries(stockItems)) {
    const def = STOCK.find((x) => x.sku === sku)!
    await db.stockMovement.create({
      data: { itemId: id, type: 'IN', qty: Math.round(def.qty * 0.6), price: def.price, note: 'Приёмка партии поставщика «МедКомплект»', createdAt: new Date(now - 14 * 86400_000 + rnd(1, 5) * 3600_000) },
    })
    stockMov++
  }
  // Расходы «на визит» по завершённым визитам yesterday
  const doneVisits = await db.visit.findMany({ include: { doctor: true }, orderBy: { createdAt: 'asc' }, take: 6 })
  for (const v of doneVisits) {
    const kit = v.doctor.specialty.includes('Стоматолог-терапевт')
      ? [['STK-001', 2], ['STK-002', 1], ['STK-003', 1], ['STK-004', 2], ['STK-006', 1]]
      : v.doctor.specialty.includes('Стоматолог-хирург')
        ? [['STK-001', 2], ['STK-002', 2], ['STK-006', 2], ['STK-007', 1]]
        : [['STK-001', 2], ['STK-008', 1]]
    for (const [sku, qty] of kit as Array<[string, number]>) {
      await db.stockMovement.create({
        data: {
          itemId: stockItems[sku],
          type: 'OUT',
          qty,
          price: STOCK.find((x) => x.sku === sku)!.price,
          visitId: v.id,
          note: `Автосписание: приём ${v.doctor.specialty}`,
          createdAt: v.createdAt,
        },
      })
      stockMov++
    }
  }
  // Списание брака
  await db.stockMovement.create({
    data: { itemId: stockItems['STK-002'], type: 'WRITEOFF', qty: 3, price: 240, note: 'Повреждена упаковка при приёмке', createdAt: new Date(now - 6 * 86400_000) },
  })
  stockMov++
  log(`Stock: ${STOCK.length} items, ${stockMov} movements`)

  // ---------- Складской контур v2: склады, перемещения, инвентаризация (ФТ-008) ----------
  const warehouses: Record<string, string> = {}
  const whDefs = [
    { code: 'MAIN', name: 'Основной склад — Ленинградская, 12', kind: 'MAIN' },
    { code: 'FILIAL', name: 'Склад филиала — ул. Северная, 3', kind: 'FILIAL' },
    { code: 'CENTRAL', name: 'Центральный склад закупок', kind: 'CENTRAL' },
  ]
  for (const w of whDefs) {
    const created = await db.warehouse.create({ data: { ...w, address: w.name.split('— ')[1] ?? null, active: true } })
    warehouses[w.code] = created.id
  }
  // Балансы: 60% на основном складе, 40% на филиале (STK-004 — целиком основной: ниже минимума)
  const mainQty = (s: (typeof STOCK)[number]): number => (s.sku === 'STK-004' ? s.qty : Math.floor(s.qty * 0.6))
  const filialQty = (s: (typeof STOCK)[number]): number => s.qty - mainQty(s)
  for (const s of STOCK) {
    await db.stockBalance.create({ data: { itemId: stockItems[s.sku], warehouseId: warehouses.MAIN, qty: mainQty(s) } })
    await db.stockBalance.create({ data: { itemId: stockItems[s.sku], warehouseId: warehouses.FILIAL, qty: filialQty(s) } })
  }

  // Историческое перемещение: центральный склад → основной (проведено)
  const t1 = await db.transferDoc.create({
    data: {
      number: 'ПМ-000001',
      fromWarehouseId: warehouses.CENTRAL,
      toWarehouseId: warehouses.MAIN,
      status: 'COMPLETED',
      comment: 'Еженедельное пополнение основного склада',
      createdBy: 'Ирина Мельник',
      createdAt: new Date(now - 5 * 86400_000),
      dispatchedAt: new Date(now - 5 * 86400_000 + 3600_000),
      completedAt: new Date(now - 5 * 86400_000 + 8 * 3600_000),
      lines: { create: [{ itemId: stockItems['STK-001'], qty: 300 }, { itemId: stockItems['STK-006'], qty: 150 }] },
    },
  })
  await db.stockMovement.create({ data: { itemId: stockItems['STK-001'], type: 'TRANSFER_OUT', qty: 300, price: 12, warehouseId: warehouses.CENTRAL, transferId: t1.id, note: 'Перемещение ПМ-000001 → Основной склад', createdAt: new Date(now - 5 * 86400_000 + 3600_000) } })
  await db.stockMovement.create({ data: { itemId: stockItems['STK-006'], type: 'TRANSFER_OUT', qty: 150, price: 7, warehouseId: warehouses.CENTRAL, transferId: t1.id, note: 'Перемещение ПМ-000001 → Основной склад', createdAt: new Date(now - 5 * 86400_000 + 3600_000) } })
  await db.stockMovement.create({ data: { itemId: stockItems['STK-001'], type: 'TRANSFER_IN', qty: 300, price: 12, warehouseId: warehouses.MAIN, transferId: t1.id, note: 'Перемещение ПМ-000001 со склада закупок', createdAt: new Date(now - 5 * 86400_000 + 8 * 3600_000) } })
  await db.stockMovement.create({ data: { itemId: stockItems['STK-006'], type: 'TRANSFER_IN', qty: 150, price: 7, warehouseId: warehouses.MAIN, transferId: t1.id, note: 'Перемещение ПМ-000001 со склада закупок', createdAt: new Date(now - 5 * 86400_000 + 8 * 3600_000) } })

  // Текущее перемещение: основной склад → филиал (в пути)
  const t2 = await db.transferDoc.create({
    data: {
      number: 'ПМ-000002',
      fromWarehouseId: warehouses.MAIN,
      toWarehouseId: warehouses.FILIAL,
      status: 'IN_TRANSIT',
      comment: 'Пополнение филиала перед выходными',
      createdBy: 'Ирина Мельник',
      createdAt: new Date(now - 20 * 3600_000),
      dispatchedAt: new Date(now - 18 * 3600_000),
      lines: { create: [{ itemId: stockItems['STK-002'], qty: 20 }, { itemId: stockItems['STK-005'], qty: 6 }] },
    },
  })
  await db.stockMovement.create({ data: { itemId: stockItems['STK-002'], type: 'TRANSFER_OUT', qty: 20, price: 240, warehouseId: warehouses.MAIN, transferId: t2.id, note: 'Перемещение ПМ-000002 → Склад филиала', createdAt: new Date(now - 18 * 3600_000) } })
  await db.stockMovement.create({ data: { itemId: stockItems['STK-005'], type: 'TRANSFER_OUT', qty: 6, price: 1250, warehouseId: warehouses.MAIN, transferId: t2.id, note: 'Перемещение ПМ-000002 → Склад филиала', createdAt: new Date(now - 18 * 3600_000) } })

  // Проведённая инвентаризация филиала: излишки/недостачи закрыты проводками
  const inv1 = await db.inventoryAct.create({
    data: {
      number: 'ИНВ-000001',
      warehouseId: warehouses.FILIAL,
      status: 'COMPLETED',
      comment: 'Плановая квартальная инвентаризация филиала',
      createdBy: 'Павел Зуев',
      createdAt: new Date(now - 4 * 86400_000),
      completedAt: new Date(now - 4 * 86400_000 + 3 * 3600_000),
      surplusCost: 2 * 1250,
      shortageCost: 3 * 430,
      lines: {
        create: STOCK.map((s) => ({
          itemId: stockItems[s.sku],
          accountedQty: filialQty(s),
          factQty: s.sku === 'STK-005' ? filialQty(s) + 2 : s.sku === 'STK-007' ? filialQty(s) - 3 : filialQty(s),
        })),
      },
    },
  })
  await db.stockMovement.create({ data: { itemId: stockItems['STK-005'], type: 'ADJ_IN', qty: 2, price: 1250, warehouseId: warehouses.FILIAL, inventoryId: inv1.id, note: 'Инвентаризация ИНВ-000001: излишек (+2)', createdAt: new Date(now - 4 * 86400_000 + 3 * 3600_000) } })
  await db.stockMovement.create({ data: { itemId: stockItems['STK-007'], type: 'ADJ_OUT', qty: 3, price: 430, warehouseId: warehouses.FILIAL, inventoryId: inv1.id, note: 'Инвентаризация ИНВ-000001: недостача (−3)', createdAt: new Date(now - 4 * 86400_000 + 3 * 3600_000) } })

  // Открытая инвентаризация основного склада: подсчёт в процессе
  await db.inventoryAct.create({
    data: {
      number: 'ИНВ-000002',
      warehouseId: warehouses.MAIN,
      status: 'OPEN',
      comment: 'Внеплановая проверка после смены кладовщика',
      createdBy: 'Ирина Мельник',
      createdAt: new Date(now - 30 * 60_000),
      lines: {
        create: STOCK.map((s) => ({
          itemId: stockItems[s.sku],
          accountedQty: mainQty(s),
          factQty: s.sku === 'STK-001' ? mainQty(s) - 10 : null, // позиция уже посчитана — недостача
        })),
      },
    },
  })

  // ---------- Выгрузки в 1С: история пакетов (ИНТ-006, складской контур) ----------
  const iso = (t: number): string => new Date(t).toISOString()
  const oneCXml = (payload: string, formed: number): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<КоммерческаяИнформация ВерсияСхемы="2.08" ДатаФормирования="${iso(formed)}">\n${payload}\n</КоммерческаяИнформация>`

  const nomPayload = `  <КаталогТМЦ>
${STOCK.map((s) => `    <Товар><Идентификатор>${s.sku}</Идентификатор><Наименование>${s.name}</Наименование><ЕдиницаИзмерения>${s.unit}</ЕдиницаИзмерения><ЦенаЗакупки>${s.price}</ЦенаЗакупки><НормаМинимум>${s.minQty}</НормаМинимум></Товар>`).join('\n')}
  </КаталогТМЦ>`
  const nomXml = oneCXml(nomPayload, now - 2 * 86400_000)

  const balPayload = whDefs
    .map((w) => {
      const code = w.code
      const rows = STOCK.slice(0, 4)
        .map((s) => {
          const qty = code === 'MAIN' ? mainQty(s) : code === 'FILIAL' ? filialQty(s) : 0
          return `    <Остаток><Номенклатура><Идентификатор>${s.sku}</Идентификатор></Номенклатура><Количество>${qty}</Количество><Стоимость>${qty * s.price}</Стоимость></Остаток>`
        })
        .join('\n')
      return `  <ОстаткиТоваров>\n    <Склад><Идентификатор>${w.code}</Идентификатор><Наименование>${w.name}</Наименование></Склад>\n${rows}\n  </ОстаткиТоваров>`
    })
    .join('\n')
  const balXml = oneCXml(balPayload, now - 86400_000)

  const docsPayload = `  <Документ Номер="1" Тип="ПоступлениеТоваров">
    <НомерДок>1</НомерДок><ДатаДок>${iso(now - 6 * 86400_000)}</ДатаДок>
    <Номенклатура><Идентификатор>STK-003</Идентификатор><Наименование>Пломбировочный материал композитный</Наименование></Номенклатура>
    <Количество>40</Количество><Цена>890</Цена><Сумма>35600</Сумма>
  </Документ>
  <Документ Номер="ПМ-000001" Тип="ПеремещениеТоваров">
    <НомерДок>ПМ-000001</НомерДок><ДатаДок>${iso(now - 5 * 86400_000)}</ДатаДок>
    <СкладОтправитель><Идентификатор>CENTRAL</Идентификатор></СкладОтправитель>
    <СкладПолучатель><Идентификатор>MAIN</Идентификатор></СкладПолучатель>
    <Строка><Номенклатура><Идентификатор>STK-001</Идентификатор></Номенклатура><Количество>300</Количество></Строка>
    <Строка><Номенклатура><Идентификатор>STK-006</Идентификатор></Номенклатура><Количество>150</Количество></Строка>
  </Документ>`
  const docsXml = oneCXml(docsPayload, now - 12 * 3600_000)

  const oneCSeed = [
    { scope: 'NOMENCLATURE', periodFrom: now - 30 * 86400_000, periodTo: now - 2 * 86400_000, status: 'CONFIRMED', attempts: 1, docsCount: 1, xml: nomXml, createdAt: now - 2 * 86400_000, sentAt: now - 2 * 86400_000 + 60_000, confirmedAt: now - 2 * 86400_000 + 120_000, error: null, comment: 'Номенклатура расходников — справочник в 1С' },
    { scope: 'BALANCES', periodFrom: now - 86400_000, periodTo: now - 86400_000, status: 'CONFIRMED', attempts: 2, docsCount: 3, xml: balXml, createdAt: now - 86400_000, sentAt: now - 86400_000 + 60_000, confirmedAt: now - 86400_000 + 300_000, error: null, comment: 'Остатки по складам на дату' },
    { scope: 'DOCS', periodFrom: now - 7 * 86400_000, periodTo: now - 12 * 3600_000, status: 'CONFIRMED', attempts: 1, docsCount: 2, xml: docsXml, createdAt: now - 12 * 3600_000, sentAt: now - 11 * 3600_000, confirmedAt: now - 10 * 3600_000, error: null, comment: 'Документы движений за неделю' },
    { scope: 'DOCS', periodFrom: now - 7 * 86400_000, periodTo: now - 10 * 60_000, status: 'QUEUED', attempts: 0, docsCount: 2, xml: docsXml, createdAt: now - 10 * 60_000, sentAt: null, confirmedAt: null, error: null, comment: 'Очередь: ждёт тика обмена раз в 15 минут' },
  ]
  for (const e of oneCSeed) {
    await db.oneCExport.create({
      data: {
        scope: e.scope,
        periodFrom: new Date(e.periodFrom),
        periodTo: new Date(e.periodTo),
        status: e.status,
        attempts: e.attempts,
        docsCount: e.docsCount,
        size: Buffer.byteLength(e.xml, 'utf8'),
        xml: e.xml,
        comment: e.comment,
        createdAt: new Date(e.createdAt),
        sentAt: e.sentAt ? new Date(e.sentAt) : null,
        confirmedAt: e.confirmedAt ? new Date(e.confirmedAt) : null,
        error: e.error,
      },
    })
  }
  await db.integrationEvent.create({ data: { system: 'ERP_1C', direction: 'OUT', summary: 'Пакет 1С «Номенклатура» подтверждён бухгалтерией', payload: JSON.stringify({ scope: 'NOMENCLATURE', docs: 1 }), status: 'CONFIRMED', createdAt: new Date(now - 2 * 86400_000) } })
  await db.integrationEvent.create({ data: { system: 'ERP_1C', direction: 'OUT', summary: 'Пакет 1С «Остатки по складам» подтверждён бухгалтерией (со 2-й попытки)', payload: JSON.stringify({ scope: 'BALANCES', docs: 3 }), status: 'CONFIRMED', createdAt: new Date(now - 86400_000) } })

  // ---------- Планировщик регулярных отчётов: расписания и история ----------
  const nextRun = (period: 'DAILY' | 'WEEKLY' | 'MONTHLY', atTime: string): Date => computeNextRunAt(period, atTime, new Date(now))

  const cashCsv = '\uFEFFСпособ;Чеков;Сумма, ₽;Средний чек, ₽\nНаличные;2;5200;2600\nКарта;1;3800;3800\nСБП;1;2600;2600\nВозвраты;0;0;0'
  const noShowCsv = '\uFEFFВрач;Приёмов;Неявок;Отмен;No-show, %\nИванова А. С.;18;2;1;11%\nПетрова М. И.;12;1;0;8%\nСмирнов О. В.;6;0;0;0%\nКузнецова О. П.;8;1;1;13%'
  const mailingCsv = '\uFEFFТип;Отправлено;Доставлено;Ошибок;Доставка, %\nREMINDER;14;13;1;93%\nWAITLIST_OFFER;3;3;0;100%\nMANUAL;2;2;0;100%'

  const schedSeed: Array<{
    data: { name: string; reportKey: string; period: 'DAILY' | 'WEEKLY' | 'MONTHLY'; atTime: string; recipients: string; createdBy: string }
    runs?: Array<{ status: string; startedAt: number; finishedAt: number; rowsCount: number; summary: string; csv: string; emailStatus: string; emailTo: string }>
    lastRunAt?: number
  }> = [
    {
      data: { name: 'Выручка дня для директора', reportKey: 'CASH_DAY', period: 'DAILY', atTime: '09:00', recipients: 'director@medflow.demo', createdBy: 'Дмитрий Ларин' },
      runs: [
        { status: 'DONE', startedAt: now - 26 * 3600_000, finishedAt: now - 26 * 3600_000 + 4_000, rowsCount: 4, summary: 'Касса за период: 4 строк (вчера, автоматически)', csv: cashCsv, emailStatus: 'SENT', emailTo: 'director@medflow.demo' },
        { status: 'DONE', startedAt: now - 50 * 3600_000, finishedAt: now - 50 * 3600_000 + 4_000, rowsCount: 4, summary: 'Касса за период: 4 строк (2 дня назад)', csv: cashCsv, emailStatus: 'SENT', emailTo: 'director@medflow.demo' },
      ],
      lastRunAt: now - 26 * 3600_000,
    },
    {
      data: { name: 'No-show недели по врачам', reportKey: 'ОТЧ-03', period: 'WEEKLY', atTime: '10:00', recipients: 'head@medflow.demo, mkt@medflow.demo', createdBy: 'Дмитрий Ларин' },
      runs: [
        { status: 'DONE', startedAt: now - 3 * 86400_000, finishedAt: now - 3 * 86400_000 + 5_000, rowsCount: 4, summary: 'No-show и отмены: 4 строк (неделя)', csv: noShowCsv, emailStatus: 'SENT', emailTo: 'head@medflow.demo, mkt@medflow.demo' },
      ],
      lastRunAt: now - 3 * 86400_000,
    },
    {
      data: { name: 'Движения ТМЦ за месяц', reportKey: 'ОТЧ-24', period: 'MONTHLY', atTime: '09:30', recipients: 'buh@medflow.demo', createdBy: 'Ольга Шестакова' },
    },
    {
      data: { name: 'Эффективность рассылок (день)', reportKey: 'ОТЧ-27', period: 'DAILY', atTime: '08:30', recipients: 'mkt@medflow.demo', createdBy: 'Светлана Ким' },
      runs: [
        { status: 'DONE', startedAt: now - 24 * 3600_000, finishedAt: now - 24 * 3600_000 + 3_000, rowsCount: 6, summary: 'Эффективность рассылок: 6 строк (вчера)', csv: mailingCsv, emailStatus: 'SENT', emailTo: 'mkt@medflow.demo' },
      ],
      lastRunAt: now - 24 * 3600_000,
    },
  ]
  for (const s of schedSeed) {
    const created = await db.reportSchedule.create({
      data: {
        ...s.data,
        active: true,
        lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
        nextRunAt: nextRun(s.data.period, s.data.atTime),
        createdAt: new Date(now - 10 * 86400_000),
      },
    })
    for (const r of s.runs ?? []) {
      await db.reportRun.create({
        data: {
          scheduleId: created.id,
          status: r.status,
          startedAt: new Date(r.startedAt),
          finishedAt: new Date(r.finishedAt),
          rowsCount: r.rowsCount,
          summary: r.summary,
          csv: r.csv,
          emailStatus: r.emailStatus,
          emailTo: r.emailTo,
        },
      })
    }
  }
  await db.integrationEvent.create({ data: { system: 'EMAIL', direction: 'IN', summary: 'Провайдер доставил письмо «Выручка дня» → director@medflow.demo', payload: JSON.stringify({ category: 'REPORT' }), status: 'CONFIRMED', createdAt: new Date(now - 26 * 3600_000) } })

  log('Складской контур v2: 3 склада, 2 перемещения, 2 инвентаризации, 4 пакета 1С, 4 расписания отчётов')

  // ---------- ЕГИСЗ (ИНТ-010): ЭМД завершённых визитов ----------
  const egiszVisits = await db.visit.findMany({ include: { patient: true }, orderBy: { createdAt: 'asc' }, take: 6 })
  let egiszCount = 0
  for (let i = 0; i < egiszVisits.length; i++) {
    const v = egiszVisits[i]
    const status = i < 2 ? 'CONFIRMED' : i === 2 ? 'SENT' : i === 3 ? 'QUEUED' : i === 4 ? 'ERROR' : 'CONFIRMED'
    await db.egiszDocument.create({
      data: {
        visitId: v.id,
        patientId: v.patientId,
        status,
        smevId: status === 'CONFIRMED' ? `СМЭВ-${(100000 + i * 7).toString(36).toUpperCase()}` : status === 'SENT' ? `СМЭВ-${(100045).toString(36).toUpperCase()}` : null,
        error: status === 'ERROR' ? 'СМЭВ недоступен; попытки исчерпаны — требуется ручная обработка (DLQ)' : null,
        attempts: status === 'ERROR' ? 5 : 1,
        createdAt: v.createdAt,
        sentAt: status !== 'QUEUED' ? new Date(v.createdAt.getTime() + 60_000) : null,
        confirmedAt: status === 'CONFIRMED' ? new Date(v.createdAt.getTime() + 90_000) : null,
      },
    })
    egiszCount++
    await db.integrationEvent.create({
      data: {
        system: 'EGISZ',
        summary: status === 'CONFIRMED'
          ? `СМЭВ подтвердил регистрацию ЭМД визита ${v.id.slice(-6).toUpperCase()} (пациент ${v.patient.lastName})`
          : status === 'ERROR'
            ? `ЭМД визита ${v.id.slice(-6).toUpperCase()}: канал СМЭВ недоступен — 5 попыток, DLQ`
            : `ЭМД визита ${v.id.slice(-6).toUpperCase()} передан в СМЭВ`,
        payload: JSON.stringify({ visitId: v.id, patientId: v.patientId, status }),
        status: status === 'CONFIRMED' ? 'CONFIRMED' : status === 'ERROR' ? 'ERROR' : 'SENT',
        attempts: 1,
        createdAt: new Date(v.createdAt.getTime() + 60_000),
      },
    })
  }
  log(`EGISZ: ${egiszCount} ЭМД (2 подтверждено, 1 в СМЭВ, 1 в очереди, 1 DLQ-демо)`)

  // ---------- Лаборатории (ИНТ-001) ----------
  const labVisit = egiszVisits[0]
  await db.labReferral.create({
    data: {
      patientId: labVisit.patientId,
      visitId: labVisit.id,
      lab: 'INVITRO',
      tests: JSON.stringify([
        { code: '01-023', name: 'Общий анализ крови' },
        { code: '02-001', name: 'Глюкоза' },
      ]),
      status: 'IMPORTED',
      resultText: 'Общий анализ крови: в пределах референсных значений; Глюкоза 5.2 ммоль/л — норма. Заключение: отклонений не выявлено.',
      sentAt: new Date(now - 40 * 3600_000),
      importedAt: new Date(now - 20 * 3600_000),
      createdAt: new Date(now - 44 * 3600_000),
    },
  })
  await db.integrationEvent.create({
    data: {
      system: 'LAB',
      summary: 'Результаты INVITRO импортированы в ЭМК пациента (автоимпорт ИНТ-001)',
      payload: JSON.stringify({ lab: 'INVITRO', imported: 2 }),
      status: 'CONFIRMED',
      createdAt: new Date(now - 20 * 3600_000),
    },
  })
  await db.labReferral.create({
    data: {
      patientId: patients[3].id,
      lab: 'HELIX',
      tests: JSON.stringify([
        { code: 'A-11', name: 'ТТГ' },
        { code: 'A-12', name: 'Т4 свободный' },
      ]),
      status: 'SENT',
      sentAt: new Date(now - 3 * 3600_000),
      error: 'HELIX: API недоступен; повтор №2 через 5 мин',
      attempts: 2,
      createdAt: new Date(now - 4 * 3600_000),
    },
  })
  await db.labReferral.create({
    data: {
      patientId: patients[6].id,
      lab: 'KDL',
      tests: JSON.stringify([{ code: 'B-101', name: 'Витамин D, 25-OH' }]),
      status: 'CREATED',
      createdAt: new Date(now - 30 * 60_000),
    },
  })

  // ---------- ДМС: полисы и реестры (ОТЧ-19) ----------
  const insurers = ['СОГАЗ', 'АльфаСтрахование', 'РЕСО-Гарантия']
  const dmsPatients = [patients[2], patients[5], patients[8]]
  for (let i = 0; i < dmsPatients.length; i++) {
    await db.insurancePolicy.create({
      data: {
        patientId: dmsPatients[i].id,
        insurer: insurers[i],
        policyNumber: `ДМС-${7701100 + i * 13}-${i + 1}`,
        validTill: new Date(now + (200 + i * 30) * 86400_000),
        createdAt: new Date(now - 300 * 86400_000),
      },
    })
  }
  const claimSeed: Array<{ p: typeof patients[number]; insurer: string; service: string; amount: number; status: string; denyReason?: string }> = [
    { p: dmsPatients[0], insurer: 'СОГАЗ', service: 'Первичный приём терапевта', amount: 2000, status: 'PAID' },
    { p: dmsPatients[0], insurer: 'СОГАЗ', service: 'ЭКГ с расшифровкой', amount: 1200, status: 'PAID' },
    { p: dmsPatients[1], insurer: 'АльфаСтрахование', service: 'Приём педиатра повторный', amount: 1700, status: 'SUBMITTED' },
    { p: dmsPatients[1], insurer: 'АльфаСтрахование', service: 'Забор крови из вены', amount: 500, status: 'DENIED', denyReason: 'Услуга не покрывается программой ДМС (демо-отказ)' },
    { p: dmsPatients[2], insurer: 'РЕСО-Гарантия', service: 'Приём педиатра первичный', amount: 2200, status: 'CREATED' },
  ]
  for (const c of claimSeed) {
    await db.dmsClaim.create({
      data: {
        patientId: c.p.id,
        insurer: c.insurer,
        serviceName: c.service,
        amount: c.amount,
        status: c.status,
        denyReason: c.denyReason ?? null,
        createdAt: new Date(now - rnd(2, 10) * 86400_000),
        submittedAt: c.status !== 'CREATED' ? new Date(now - rnd(1, 5) * 86400_000) : null,
        paidAt: c.status === 'PAID' ? new Date(now - rnd(1, 4) * 86400_000) : null,
      },
    })
  }
  log(`DMS: ${dmsPatients.length} полисов, ${claimSeed.length} строк реестра`)

  // ---------- Телефония CTI (ИНТ-003, ФТ-011) ----------
  const callSeed: Array<{ phone: string; patientIdx: number | null; status: string; minutesAgo: number }> = [
    { phone: patients[1].phone, patientIdx: 1, status: 'ANSWERED', minutesAgo: 95 },
    { phone: patients[4].phone, patientIdx: 4, status: 'MISSED', minutesAgo: 40 },
    { phone: '+7 999 000-00-11', patientIdx: null, status: 'MISSED', minutesAgo: 18 },
    { phone: patients[7].phone, patientIdx: 7, status: 'ANSWERED', minutesAgo: 8 },
  ]
  for (const c of callSeed) {
    await db.callEvent.create({
      data: {
        phone: c.phone,
        patientId: c.patientIdx !== null ? patients[c.patientIdx].id : null,
        direction: 'IN',
        status: c.status,
        duration: c.status === 'ANSWERED' ? rnd(30, 180) : 0,
        recording: c.status === 'ANSWERED',
        createdAt: new Date(now - c.minutesAgo * 60_000),
      },
    })
  }
  log(`CTI: ${callSeed.length} звонков (2 пропущенных — задачи)`)

  // ---------- Стартовый журнал аудита (ФТ-039) ----------
  const auditSeed: Array<{ action: string; userId: string | null; meta: string }> = [
    { action: 'auth.login', userId: users[1].id, meta: JSON.stringify({ login: 'reg1', role: 'REGISTRAR' }) },
    { action: 'auth.login', userId: users[0].id, meta: JSON.stringify({ login: 'admin', role: 'ADMIN' }) },
    { action: 'appointment.created', userId: users[1].id, meta: JSON.stringify({ source: 'REGISTRAR' }) },
    { action: 'visit.completed', userId: users[3].id, meta: JSON.stringify({ diagnosis: 'K02.1' }) },
    { action: 'payment.created', userId: users[1].id, meta: JSON.stringify({ method: 'CARD' }) },
    { action: 'payment.fiscalized', userId: users[1].id, meta: JSON.stringify({ fiscalNumber: 'ФН 9928-44 · ФД 200001' }) },
    { action: 'document.signed', userId: users[1].id, meta: JSON.stringify({ template: 'CONSENT_MED' }) },
    { action: 'price.updated', userId: users[0].id, meta: JSON.stringify({ service: 'Профессиональная гигиена полости рта', oldPrice: 4000, newPrice: 4500 }) },
    { action: 'waiting.slot_offered', userId: users[1].id, meta: JSON.stringify({ slot: '10:00', ttl: 15 }) },
    { action: 'waiting.booked', userId: users[1].id, meta: JSON.stringify({ fromOffer: true, doctor: 'Иванова А. С.' }) },
    { action: 'reminder.responded', userId: users[1].id, meta: JSON.stringify({ response: 'CONFIRMED' }) },
    { action: 'widget.booking_created', userId: null, meta: JSON.stringify({ source: 'WIDGET', instant: true }) },
  ]
  for (const a of auditSeed) {
    await db.auditLog.create({ data: { ...a, createdAt: new Date(now - rnd(5, 50) * 60 * 1000) } })
  }

  const counts = {
    doctors: await db.doctor.count(),
    patients: await db.patient.count(),
    appointments: await db.appointment.count(),
    visits: await db.visit.count(),
    templates: await db.protocolTemplate.count(),
    sessions: await db.workSession.count(),
    services: await db.serviceItem.count(),
    payments: await db.payment.count(),
    docTemplates: await db.documentTemplate.count(),
    signedDocs: await db.signedDocument.count(),
    audit: await db.auditLog.count(),
    staff: await db.staffUser.count(),
    waiting: await db.waitingListEntry.count(),
    reminders: await db.reminder.count(),
    notifications: await db.notification.count(),
    notifyTemplates: await db.notificationTemplate.count(),
    stockItems: await db.stockItem.count(),
    stockMovements: await db.stockMovement.count(),
    warehouses: await db.warehouse.count(),
    transfers: await db.transferDoc.count(),
    inventories: await db.inventoryAct.count(),
    oneCExports: await db.oneCExport.count(),
    reportSchedules: await db.reportSchedule.count(),
    reportRuns: await db.reportRun.count(),
    egisz: await db.egiszDocument.count(),
    labs: await db.labReferral.count(),
    dmsClaims: await db.dmsClaim.count(),
    calls: await db.callEvent.count(),
  }
  log(`Seed done: ${JSON.stringify(counts)}`)
}
