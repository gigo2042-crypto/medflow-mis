// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { actorId, actorMeta, audit, isService, requirePerm, requireServiceOrPerm } from '@/lib/auth-server'
import { hadWork } from '@/lib/audit-utils'
import { integrationsSimulated } from '@/lib/integrations'
import { integrationCatalog, RETRY_MINUTES, logEvent, processIntegrations, simulateIncomingCall } from '@/lib/integrations'
import { processOutbox } from '@/lib/notify'
import { LabReferralDTO, DmsClaimDTO } from '@/lib/types'
import { HIDDEN, canSeeMedical, canSeePd, maskPhone } from '@/lib/pd-access'

export const dynamic = 'force-dynamic'

// Интеграции (ИНТ-001..018): каталог систем, outbox-журнал обмена,
// очередь ЭМД в ЕГИСЗ, лабораторные направления, ДМС-реестры и CTI-телефония.
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'integrations.read')
  if (!g.ok) return g.res
  // ПДн — только при patients.read, результаты анализов — только при medical.read
  const pd = canSeePd(g.user)
  const med = canSeeMedical(g.user)
  const nm = (s: string) => (pd ? s : HIDDEN)
  try {
    const [egisz, labs, claims, calls, events, policies] = await Promise.all([
      db.egiszDocument.findMany({
        orderBy: { createdAt: 'desc' },
        take: 60,
        include: { visit: { include: { patient: { select: { lastName: true, firstName: true, cardNumber: true } }, doctor: { select: { name: true, specialty: true } } } } },
      }),
      db.labReferral.findMany({
        orderBy: { createdAt: 'desc' },
        take: 40,
        include: { visit: { include: { patient: { select: { lastName: true, firstName: true } } } } },
      }),
      db.dmsClaim.findMany({ orderBy: { createdAt: 'desc' }, take: 80 }),
      db.callEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 40 }),
      db.integrationEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 80 }),
      db.insurancePolicy.findMany({ include: { patient: { select: { lastName: true, firstName: true, cardNumber: true } } }, take: 30 }),
    ])

    const egiszDto = egisz.map((d) => ({
      id: d.id,
      visitId: d.visitId,
      patientId: d.patientId,
      patientName: d.visit ? nm(`${d.visit.patient.lastName} ${d.visit.patient.firstName}`) : '—',
      cardNumber: pd ? d.visit?.patient.cardNumber ?? null : null,
      doctorName: d.visit?.doctor.name ?? null,
      specialty: d.visit?.doctor.specialty ?? null,
      status: d.status,
      smevId: d.smevId,
      error: d.error,
      attempts: d.attempts,
      createdAt: d.createdAt.toISOString(),
      sentAt: d.sentAt?.toISOString() ?? null,
      confirmedAt: d.confirmedAt?.toISOString() ?? null,
    }))

    const labsDto: LabReferralDTO[] = labs.map((r) => ({
      id: r.id,
      patientId: r.patientId,
      patientName: r.visit ? nm(`${r.visit.patient.lastName} ${r.visit.patient.firstName}`) : '—',
      visitId: r.visitId,
      lab: r.lab,
      tests: safeTests(r.tests),
      status: r.status,
      resultText: med ? r.resultText : r.resultText ? 'Результат получен (доступен врачу)' : null,
      error: r.error,
      attempts: r.attempts,
      sentAt: r.sentAt?.toISOString() ?? null,
      importedAt: r.importedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }))

    const claimsDto: DmsClaimDTO[] = claims.map((c) => ({
      id: c.id,
      visitId: c.visitId,
      patientId: c.patientId,
      insurer: c.insurer,
      serviceName: c.serviceName,
      amount: c.amount,
      status: c.status,
      denyReason: c.denyReason,
      createdAt: c.createdAt.toISOString(),
      submittedAt: c.submittedAt?.toISOString() ?? null,
      paidAt: c.paidAt?.toISOString() ?? null,
    }))

    const callsDto = calls.map((c) => ({
      id: c.id,
      phone: pd ? c.phone : maskPhone(c.phone),
      patientId: c.patientId,
      direction: c.direction,
      status: c.status,
      duration: c.duration,
      recording: c.recording,
      createdAt: c.createdAt.toISOString(),
    }))

    const eventsDto = events.map((e) => ({
      id: e.id,
      system: e.system,
      direction: e.direction,
      summary: e.summary,
      status: e.status,
      attempts: e.attempts,
      error: e.error,
      createdAt: e.createdAt.toISOString(),
    }))

    const stats = {
      egiszQueued: egisz.filter((d) => d.status === 'QUEUED').length,
      egiszConfirmed: egisz.filter((d) => d.status === 'CONFIRMED').length,
      egiszError: egisz.filter((d) => d.status === 'ERROR').length,
      labsPending: labs.filter((r) => ['CREATED', 'SENT', 'RESULT_READY'].includes(r.status)).length,
      labsImported: labs.filter((r) => r.status === 'IMPORTED').length,
      dmsCreated: claims.filter((c) => c.status === 'CREATED').length,
      dmsPaid: claims.filter((c) => c.status === 'PAID').length,
      dmsDenied: claims.filter((c) => c.status === 'DENIED').length,
      dmsRevenue: claims.filter((c) => c.status === 'PAID').reduce((s, c) => s + c.amount, 0),
      missedCalls: calls.filter((c) => c.status === 'MISSED').length,
      activeTasks: calls.filter((c) => c.status === 'TASK').length,
      dlq: events.filter((e) => e.status === 'DLQ' || e.status === 'ERROR').length,
    }

    return NextResponse.json({
      catalog: integrationCatalog(),
      retrySchedule: RETRY_MINUTES,
      egisz: egiszDto,
      labs: labsDto,
      claims: claimsDto,
      calls: callsDto,
      events: eventsDto,
      policies: policies.map((p) => ({
        id: p.id,
        patientId: p.patientId,
        patientName: nm(`${p.patient.lastName} ${p.patient.firstName}`),
        cardNumber: pd ? p.patient.cardNumber : HIDDEN,
        insurer: p.insurer,
        policyNumber: pd ? p.policyNumber : HIDDEN,
        validTill: p.validTill?.toISOString() ?? null,
        active: p.active,
      })),
      stats,
    })
  } catch (e) {
    console.error('[integrations GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить интеграции' }, { status: 500 })
  }
}

function safeTests(tests: string): Array<{ code: string; name: string }> {
  try {
    return JSON.parse(tests) ?? []
  } catch {
    return []
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, any>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 })
  }
  const action = body.action
  // Лаб. направление создаёт врач (право labs.create, чеклист п.11); тик воркера — планировщик
  const g = action === 'CREATE_REFERRAL'
    ? await requirePerm(req, 'labs.create')
    : action === 'PROCESS'
      ? await requireServiceOrPerm(req, 'integrations.manage')
      : await requirePerm(req, 'integrations.manage')
  if (!g.ok) return g.res
  try {

    // Воркер интеграций: очереди ЭМД/лаб/ДМС с backoff и DLQ (ИНТ-001, ИНТ-010)
    if (action === 'PROCESS') {
      const res = await processIntegrations()
      if (!isService(req) || hadWork({ ...res })) await audit('integrations.processed', actorId(g), { ...res, ...actorMeta(g) })
      return NextResponse.json({ worker: res })
    }

    // Служебному вызову (x-service-key) доступен только запуск воркера
    if (!g.user) return NextResponse.json({ error: 'Служебный вызов: только PROCESS' }, { status: 403 })

    // Отправка ЭМД конкретного визита в ЕГИСЗ (ИНТ-010)
    if (action === 'SEND_EMD') {
      if (!body.visitId) return NextResponse.json({ error: 'Укажите visitId' }, { status: 400 })
      const visit = await db.visit.findUnique({ where: { id: body.visitId } })
      if (!visit) return NextResponse.json({ error: 'Визит не найден' }, { status: 404 })
      await db.egiszDocument
        .create({ data: { visitId: visit.id, patientId: visit.patientId } })
        .catch(() => undefined)
      await logEvent({
        system: 'EGISZ',
        summary: `ЭМД визита ${visit.id.slice(-6).toUpperCase()} поставлен в очередь передачи в СМЭВ 3`,
        payload: { visitId: visit.id, patientId: visit.patientId },
      })
      await audit('integrations.emd_queued', actorId(g), { visitId: visit.id })
      return NextResponse.json({ ok: true })
    }

    // Создание лабораторного направления (ИНТ-001)
    if (action === 'CREATE_REFERRAL') {
      if (!body.patientId || !body.lab || !Array.isArray(body.tests) || body.tests.length === 0) {
        return NextResponse.json({ error: 'Укажите patientId, lab и список исследований' }, { status: 400 })
      }
      if (g.user.role === 'DOCTOR' && body.visitId) {
        const v = await db.visit.findUnique({ where: { id: String(body.visitId) } })
        if (!v || v.doctorId !== g.user.doctorId || v.patientId !== body.patientId) {
          return NextResponse.json({ error: 'Направление можно создать только по своему приёму' }, { status: 403 })
        }
      }
      if (!['INVITRO', 'HELIX', 'KDL'].includes(String(body.lab).toUpperCase())) {
        return NextResponse.json({ error: 'Неизвестная лаборатория' }, { status: 400 })
      }
      const tests = body.tests.slice(0, 30).map((t: { code: string; name: string }) => ({ code: String(t.code).slice(0, 20), name: String(t.name).slice(0, 120) }))
      const referral = await db.labReferral.create({
        data: {
          patientId: body.patientId,
          visitId: body.visitId || null,
          lab: String(body.lab).toUpperCase(),
          tests: JSON.stringify(tests),
        },
      })
      await logEvent({
        system: 'LAB',
        summary: `Создано направление в ${referral.lab}: ${tests.map((t: { name: string }) => t.name).join(', ')}`,
        payload: { referralId: referral.id, lab: referral.lab, tests },
      })
      await audit('integrations.referral_created', g.user.id, { referralId: referral.id, lab: referral.lab })
      return NextResponse.json({ ok: true, referralId: referral.id }, { status: 201 })
    }

    // Телефония CTI (ИНТ-003, ФТ-011): «входящий звонок» с карточкой пациента
    if (action === 'CALL_IN') {
      if (!integrationsSimulated()) {
        return NextResponse.json({ error: 'Телефония (CTI) не подключена' }, { status: 501 })
      }
      const phone = String(body.phone || '').trim()
      if (phone.replace(/\D/g, '').length < 10) {
        return NextResponse.json({ error: 'Укажите телефон (не короче 10 цифр)' }, { status: 400 })
      }
      const call = await simulateIncomingCall(phone)
      await audit('integrations.call_in', g.user.id, { phone, patientId: call?.patientId ?? null })
      return NextResponse.json({ call })
    }

    // Ответ/пропуск звонка: ANSWERED | MISSED (MISSED → задача регистратуры)
    if (action === 'CALL_STATUS') {
      if (!body.id || !['ANSWERED', 'MISSED', 'TASK'].includes(body.status)) {
        return NextResponse.json({ error: 'Укажите id и status: ANSWERED | MISSED | TASK' }, { status: 400 })
      }
      const call = await db.callEvent.findUnique({ where: { id: body.id } })
      if (!call) return NextResponse.json({ error: 'Звонок не найден' }, { status: 404 })
      await db.callEvent.update({
        where: { id: body.id },
        data: {
          status: body.status,
          duration: body.status === 'ANSWERED' ? 42 : call.duration,
          recording: body.status === 'ANSWERED' ? true : call.recording,
        },
      })
      await logEvent({
        system: 'TELEPHONY',
        summary: `Звонок ${call.phone}: ${body.status === 'ANSWERED' ? 'принят, разговор записан' : 'пропущен — задача на перезвон'}`,
        payload: { callId: call.id, status: body.status },
        status: 'SENT',
      })
      await audit('integrations.call_status', g.user.id, { callId: body.id, status: body.status })
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 })
  } catch (e) {
    if (e instanceof Error) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error('[integrations POST]', e)
    return NextResponse.json({ error: 'Не удалось выполнить действие' }, { status: 500 })
  }
}

// Доставка накопившихся складских уведомлений (STOCK_LOW) через Центр уведомлений
export async function PUT(req: NextRequest) {
  const g = await requirePerm(req, 'integrations.manage')
  if (!g.ok) return g.res
  try {
    const delivery = await processOutbox()
    return NextResponse.json({ delivery })
  } catch (e) {
    console.error('[integrations PUT]', e)
    return NextResponse.json({ error: 'Не удалось доставить уведомления' }, { status: 500 })
  }
}
