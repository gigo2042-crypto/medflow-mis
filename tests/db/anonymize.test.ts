// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Чек-лист P0 «Персональные данные»: обезличивание не оставляет следа ПДн ни в одной таблице.
// Тест создаёт пациента с MAX, черновиком виджета, платежом с заметкой и записями во всех журналах,
// обезличивает, затем проходит grep по ВСЕМ таблицам БД на ФИО (во всех падежах) и телефон.
// Все данные вымышленные.
import { beforeEach, describe, expect, it } from 'vitest'
import { authed, makeDoctor, makeVisit, productionEnv, resetDb, staffSession, useTestDb } from './helpers'
import { containsPatientPd } from '@/lib/pii'

useTestDb()
let db: Awaited<ReturnType<typeof resetDb>>

beforeEach(async () => {
  db = await resetDb()
  productionEnv()
})

const NAMES = ['Вымыслова', 'Глафира', 'Тестовна']
const PHONE = '+7 900 777-66-55'
const EMAIL = 'glafira.fake@example.test'
const IP = '203.0.113.77'
const POLICY = '7700112233445566'

async function seedTraces() {
  const doctor = await makeDoctor(db)
  const p = await db.patient.create({
    data: {
      cardNumber: 'MF-9001', lastName: NAMES[0], firstName: NAMES[1], middleName: NAMES[2], phone: PHONE, email: EMAIL,
      birthDate: new Date('1985-07-14'), gender: 'F', notes: 'Аллергия; просит звонить на 89007776655',
      maxUserId: 'max-user-fake-1', maxLinkedAt: new Date(),
    },
  })
  const visit = await makeVisit(db, p.id, doctor.id, {
    complaints: 'Вымысловой Глафире Тестовне больно, со слов Вымысловой — с понедельника',
    protocolText: 'Пациентка Вымыслова Г.Т., тел. 8 (900) 777-66-55. Объективно: кариес.',
    templateData: JSON.stringify({ 'Жалобы||note': 'Глафира Тестовна жалуется' }),
  })
  const tpl = await db.documentTemplate.create({ data: { code: 'TEST_DOC', name: 'Тест', kind: 'CONSENT', body: '{{patient}}' } })
  await db.signedDocument.create({ data: { patientId: p.id, templateId: tpl.id, visitId: visit.id, title: 'Согласие — Вымыслова Г. Т.', content: 'Я, Вымыслова Глафира Тестовна, тел. +79007776655, даю согласие…' } })
  await db.payment.create({ data: { patientId: p.id, visitId: visit.id, amount: 1500, method: 'CASH', type: 'PAYMENT', status: 'PAID', note: 'оплатил муж Вымыслов, тел 8 900 7776655' } })
  await db.consentRecord.create({ data: { patientId: p.id, kind: 'PD', action: 'GIVEN', source: 'WIDGET', ip: IP } })
  await db.notification.create({ data: { patientId: p.id, patientName: 'Вымыслова Глафира', phone: '79007776655', text: 'Глафира, напоминаем о записи', channel: 'SMS', kind: 'REMINDER', status: 'SENT' } })
  const appt = await db.appointment.findFirstOrThrow({ where: { patientId: p.id } })
  await db.reminder.create({ data: { appointmentId: appt.id, level: 1, channel: 'SMS', status: 'SENT', plannedAt: new Date(), text: 'Глафира Тестовна, ждём вас', response: 'это Вымыслова, приду' } })
  await db.waitingListEntry.create({ data: { patientId: p.id, comment: 'Звонить Вымысловой после 18, 89007776655' } })
  await db.labReferral.create({ data: { patientId: p.id, visitId: visit.id, lab: 'INVITRO', tests: '[]', resultText: 'Пациент: Вымыслова Глафира Тестовна. Гемоглобин 130 г/л' } })
  await db.insurancePolicy.create({ data: { patientId: p.id, insurer: 'СОГАЗ', policyNumber: POLICY } })
  await db.callEvent.create({ data: { phone: '+79007776655', patientId: p.id } })
  await db.callEvent.create({ data: { phone: '8 900 777 66 55' } }) // звонок до привязки к карте
  await db.notificationBlacklist.create({ data: { phone: '79007776655', patientId: p.id, reason: 'просила не писать' } })
  // без ссылки на пациента
  await db.widgetDraft.create({ data: { doctorId: doctor.id, start: new Date(Date.now() + 86400_000), name: 'Вымыслова Глафира', phone: '79007776655', code: '111222', consentIp: IP, expiresAt: new Date(Date.now() + 600_000) } })
  await db.integrationEvent.create({ data: { system: 'LAB', summary: 'Результат для Вымысловой Г.Т.', payload: JSON.stringify({ patient: { fio: 'Вымыслова Глафира Тестовна', phone: '+7 900 777 66 55' }, tests: ['HGB'] }) } })
  await db.oneCExport.create({ data: { scope: 'DOCS', periodFrom: new Date(Date.now() - 86400_000), periodTo: new Date(), xml: '<doc><client>Вымыслова Глафира Тестовна</client><sum>1500</sum></doc>' } })
  const sched = await db.reportSchedule.create({ data: { name: 'Тест', reportKey: 'CASH_DAY', recipients: 'head@example.test', nextRunAt: new Date() } })
  await db.reportRun.create({ data: { scheduleId: sched.id, status: 'DONE', csv: 'ФИО;Сумма\nВымыслова Глафира Тестовна;1500', summary: 'строк: 1' } })
  return { p, doctor }
}

async function grepAllTables(): Promise<string[]> {
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  const hits: string[] = []
  for (const { tablename } of tables) {
    const rows = await db.$queryRawUnsafe<Array<{ j: string }>>(`SELECT row_to_json(t)::text AS j FROM "${tablename}" t`)
    for (const { j } of rows) {
      if (containsPatientPd(j, { names: NAMES, phones: [PHONE] }) || j.includes(EMAIL) || j.includes(IP) || j.includes(POLICY) || j.includes('max-user-fake-1')) {
        hits.push(`${tablename}: ${j.slice(0, 160)}`)
      }
    }
  }
  return hits
}

describe('обезличивание пациента (152-ФЗ ст.21)', () => {
  it('после обезличивания grep по всем таблицам не находит ФИО (в падежах), телефон, e-mail, IP, полис, MAX', async () => {
    const { p } = await seedTraces()
    expect((await grepAllTables()).length).toBeGreaterThan(10) // проверка самой проверки: до обезличивания след есть
    const admin = await staffSession(db, 'ADMIN')
    const { DELETE } = await import('@/app/api/patients/[id]/route')
    const res = await DELETE(await authed(admin.cookie, 'DELETE', `/api/patients/${p.id}`, { confirm: 'ОБЕЗЛИЧИТЬ', reason: 'заявление Вымысловой Г.Т. от 01.11' }), { params: Promise.resolve({ id: p.id }) })
    expect(res.status).toBe(200)
    const hits = await grepAllTables()
    expect(hits).toEqual([])

    const after = await db.patient.findUniqueOrThrow({ where: { id: p.id } })
    expect(after.maxUserId).toBeNull()
    expect(after.maxLinkedAt).toBeNull()
    expect(after.anonymizedAt).not.toBeNull()
    // медицинское содержание и суммы сохранены
    const v = await db.visit.findFirstOrThrow({ where: { patientId: p.id } })
    expect(v.protocolText).toContain('Объективно: кариес')
    expect((await db.labReferral.findFirstOrThrow({ where: { patientId: p.id } })).resultText).toContain('Гемоглобин 130 г/л')
    expect((await db.payment.findFirstOrThrow({ where: { patientId: p.id } })).amount).toBe(1500)
    expect(JSON.parse((await db.integrationEvent.findFirstOrThrow()).payload).tests).toEqual(['HGB'])
    expect((await db.insurancePolicy.findFirstOrThrow()).policyNumber).toBe('****5566')
    expect(await db.widgetDraft.count()).toBe(0)
    const a = await db.auditLog.findFirstOrThrow({ where: { action: 'patient.anonymized' } })
    expect(a.meta).not.toMatch(/Вымыслов/)
  })

  it('повторное обезличивание — без ошибок и без изменений', async () => {
    const { p } = await seedTraces()
    const { anonymizePatient } = await import('@/lib/consent')
    await anonymizePatient(p.id)
    expect(await anonymizePatient(p.id)).toEqual({ canceledAppointments: 0, scrubbed: {} })
  })
})

describe('черновики виджета: ПДн не хранятся дольше нужного', () => {
  async function draft(data: Record<string, unknown>) {
    const doctor = await makeDoctor(db)
    return db.widgetDraft.create({ data: { doctorId: doctor.id, start: new Date(Date.now() + 86400_000), name: 'Фейкова Анна', phone: '79001230000', code: '123456', consentIp: IP, expiresAt: new Date(Date.now() + 600_000), ...data } })
  }
  it('истёкший черновик: статус EXPIRED, ФИО/телефон/код/IP стёрты', async () => {
    const d = await draft({ expiresAt: new Date(Date.now() - 1000) })
    const { expireWidgetDrafts } = await import('@/lib/waiting')
    expect(await expireWidgetDrafts()).toBe(1)
    const x = await db.widgetDraft.findUniqueOrThrow({ where: { id: d.id } })
    expect(x).toMatchObject({ status: 'EXPIRED', name: '', phone: '', code: '', consentIp: null })
  })
  it('активный черновик не трогается; подтверждённый/истёкший старше суток — удаляется', async () => {
    const live = await draft({})
    const old = await draft({ status: 'CONFIRMED', createdAt: new Date(Date.now() - 25 * 3600_000) })
    const oldPending = await draft({ createdAt: new Date(Date.now() - 25 * 3600_000), expiresAt: new Date(Date.now() - 24 * 3600_000) })
    const { expireWidgetDrafts } = await import('@/lib/waiting')
    await expireWidgetDrafts()
    expect((await db.widgetDraft.findUniqueOrThrow({ where: { id: live.id } })).phone).toBe('79001230000')
    expect(await db.widgetDraft.findUnique({ where: { id: old.id } })).toBeNull()
    expect(await db.widgetDraft.findUnique({ where: { id: oldPending.id } })).toBeNull()
  })
  it('подтверждённый без очистки (старые данные) — доочищается', async () => {
    const d = await draft({ status: 'CONFIRMED' })
    const { expireWidgetDrafts } = await import('@/lib/waiting')
    await expireWidgetDrafts()
    expect(await db.widgetDraft.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ name: '', phone: '', code: '', consentIp: null })
  })
})
