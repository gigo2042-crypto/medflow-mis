// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Интеграции МИС (ИНТ-001..018): ЕГИСЗ/РЕМД через СМЭВ 3 (ИНТ-010),
// лаборатории INVITRO/HELIX/KDL (ИНТ-001), ДМС-реестры (ОТЧ-19),
// телефония CTI (ИНТ-003/ФТ-011). Обмен копится в transactional outbox
// (АРХ-004): повторы с backoff 1/5/15/60/240 минут, затем DLQ (ИНТ-001).
// Серверный модуль — не импортировать в клиентский код!

import { db } from '@/lib/db'
import { isDemo } from '@/lib/config'
import { fiscalStatus } from '@/lib/fiscal'
import { maxConfig } from '@/lib/max'
import { oidcEnabled } from '@/lib/oidc'

/**
 * Внешние шлюзы (СМЭВ/ЕГИСЗ, лаборатории, ДМС, CTI, 1С) в этой версии реализованы
 * как симуляторы. В production они выключены: очереди копятся, но «успешные» ответы
 * не подделываются. Подключение реальных шлюзов — отдельный проект.
 */
export function integrationsSimulated(): boolean {
  return isDemo()
}

// Расписание повторов из ТЗ (ИНТ-001): 1, 5, 15, 60, 240 минут, далее DLQ
export const RETRY_MINUTES = [1, 5, 15, 60, 240]

// Честный статус интеграции:
//   CONFIGURED    — настроены реквизиты реального провайдера (доступность не проверяется пингом);
//   SIMULATOR     — демо: обмен имитируется внутри МИС, наружу ничего не уходит;
//   MANUAL        — автоматического обмена нет, доступна ручная выгрузка файлов;
//   NOT_CONNECTED — коннектора к реальной системе нет / не настроен.
export type IntegrationHealth = 'CONFIGURED' | 'SIMULATOR' | 'MANUAL' | 'NOT_CONNECTED'

export interface IntegrationCatalogItem {
  key: string
  name: string
  protocol: string
  area: string
  requirement: string // ИНТ-XXX
  health: IntegrationHealth
  note: string
}

type CatalogBase = Omit<IntegrationCatalogItem, 'health' | 'note'> & { note: string; status: () => { health: IntegrationHealth; why: string } }

const simulatorOr = (prodWhy: string) => (): { health: IntegrationHealth; why: string } =>
  isDemo() ? { health: 'SIMULATOR', why: 'Демо: обмен имитируется, во внешнюю систему ничего не отправляется.' } : { health: 'NOT_CONNECTED', why: prodWhy }

const CATALOG: CatalogBase[] = [
  { key: 'EGISZ', name: 'ЕГИСЗ / РЭМД', protocol: 'СМЭВ 3, РЭМД CDA', area: 'ЕГИСЗ', requirement: 'ИНТ-010', note: 'Очередь ЭМД по завершённым визитам.', status: simulatorOr('Коннектора к РЭМД нет: нужна регистрация МИС, сертификаты и реализация обмена.') },
  { key: 'LAB', name: 'Лаборатории', protocol: 'REST API', area: 'Лаборатории', requirement: 'ИНТ-001', note: 'Очередь направлений с повторами 1/5/15/60/240 мин и DLQ.', status: simulatorOr('Коннекторов к лабораториям нет: нужны договор и API конкретной лаборатории.') },
  { key: 'DMS', name: 'Страховые компании (ДМС)', protocol: 'Реестры ДМС', area: 'ДМС', requirement: 'ОТЧ-19', note: 'Реестры услуг, статусы оплат и отказов.', status: simulatorOr('Обмена со страховыми нет: реестры формируются, но не отправляются.') },
  { key: 'TELEPHONY', name: 'Телефония (CTI)', protocol: 'WebSocket/REST, AMI', area: 'Телефония', requirement: 'ИНТ-003', note: 'Карточка звонка, пропущенные — задачи регистратуре.', status: simulatorOr('Коннектора к АТС нет: звонки вносятся вручную.') },
  {
    key: 'FISCAL', name: 'Онлайн-касса 54-ФЗ: АТОЛ Онлайн', protocol: 'REST v5, ФФД 1.2', area: 'Фискализация', requirement: 'ИНТ-005', note: 'Чеки прихода и возврата, опрос результата.',
    status: () => {
      const f = fiscalStatus()
      if (f.demo) return { health: 'SIMULATOR', why: 'Демо: чеки не фискализируются.' }
      return f.configured ? { health: 'CONFIGURED', why: 'Реквизиты АТОЛ заданы; работоспособность подтверждается первым чеком.' } : { health: 'NOT_CONNECTED', why: f.problem || 'Не настроено.' }
    },
  },
  {
    key: 'SMS', name: 'SMS-шлюз: SMS.ru', protocol: 'HTTP API', area: 'Сообщения', requirement: 'ФТ-013', note: 'Напоминания, коды виджета, фолбэк для MAX.',
    status: () => (isDemo() ? { health: 'SIMULATOR', why: 'Демо: SMS не отправляются.' } : process.env.SMS_PROVIDER === 'smsru' ? { health: 'CONFIGURED', why: 'SMS_PROVIDER=smsru.' } : { health: 'NOT_CONNECTED', why: 'SMS_PROVIDER не задан.' }),
  },
  {
    key: 'MAX', name: 'Мессенджер MAX (бот)', protocol: 'MAX Bot API, вебхук', area: 'Сообщения', requirement: 'ФТ-005', note: 'Напоминания с кнопками ответа пациентам, подключившим бота.',
    status: () => {
      if (isDemo()) return { health: 'SIMULATOR', why: 'Демо: сообщения MAX имитируются.' }
      const m = maxConfig()
      return m.configured ? { health: 'CONFIGURED', why: 'Бот настроен; подписка вебхука — npm run max:subscribe.' } : { health: 'NOT_CONNECTED', why: m.problem || 'Не настроено.' }
    },
  },
  {
    key: 'EMAIL', name: 'E-mail (SMTP)', protocol: 'SMTP', area: 'Почта', requirement: 'ИНТ-014', note: 'Транзакционные письма, отчёты.',
    status: () => (isDemo() ? { health: 'SIMULATOR', why: 'Демо: локальный тестовый провайдер.' } : process.env.EMAIL_PROVIDER === 'smtp' ? { health: 'CONFIGURED', why: 'EMAIL_PROVIDER=smtp.' } : { health: 'NOT_CONNECTED', why: 'EMAIL_PROVIDER не задан.' }),
  },
  {
    key: 'SSO', name: 'Единый вход (OIDC)', protocol: 'OIDC 1.0', area: 'Доступ', requirement: 'ИНТ-013', note: 'Вход сотрудников через корпоративный IdP.',
    status: () => (oidcEnabled() ? { health: 'CONFIGURED', why: 'OIDC_* заданы.' } : isDemo() ? { health: 'SIMULATOR', why: 'Демо-IdP (если запущен).' } : { health: 'NOT_CONNECTED', why: 'OIDC не настроен: вход по паролю и 2FA.' }),
  },
  {
    key: 'ERP_1C', name: '1С (складской контур)', protocol: 'CommerceML-XML', area: 'ERP', requirement: 'ИНТ-006', note: 'Выгрузки номенклатуры, остатков и документов.',
    status: () => (isDemo() ? { health: 'SIMULATOR', why: 'Демо: подтверждения 1С имитируются.' } : { health: 'MANUAL', why: 'Автообмена нет: XML скачивается и загружается в 1С вручную.' }),
  },
]

/** Каталог с фактическими статусами (вычисляются на каждый запрос из конфигурации). */
export function integrationCatalog(): IntegrationCatalogItem[] {
  return CATALOG.map(({ status, note, ...c }) => {
    const s = status()
    return { ...c, health: s.health, note: `${s.why} ${note}` }
  })
}

// Запись события в outbox-журнал (АРХ-004)
export async function logEvent(input: {
  system: string
  summary: string
  payload: Record<string, unknown>
  status?: string
  direction?: 'OUT' | 'IN'
}): Promise<void> {
  await db.integrationEvent.create({
    data: {
      system: input.system,
      direction: input.direction ?? 'OUT',
      summary: input.summary,
      payload: JSON.stringify(input.payload),
      status: input.status ?? 'QUEUED',
    },
  })
}

export interface WorkerResult {
  emdSent: number
  emdConfirmed: number
  emdRetried: number
  emdDlq: number
  labsSent: number
  labsResults: number
  labsImported: number
  labsRetried: number
  labsDlq: number
  dmsSubmitted: number
  dmsResolved: number
  eventsLogged: number
}

// Воркер интеграций: обрабатывает очереди ЭМД, лабораторных направлений
// и ДМС-реестров с повторами по расписанию RETRY_MINUTES и DLQ.
// Демо-каналы: СМЭВ 95% успеха, лаборатории 80% (у HELIX деградация),
// ДМС-шлюз 90%.
export async function processIntegrations(): Promise<WorkerResult> {
  const now = new Date()
  const res: WorkerResult = {
    emdSent: 0, emdConfirmed: 0, emdRetried: 0, emdDlq: 0,
    labsSent: 0, labsResults: 0, labsImported: 0, labsRetried: 0, labsDlq: 0,
    dmsSubmitted: 0, dmsResolved: 0, eventsLogged: 0,
  }
  if (!integrationsSimulated()) return res

  // ---------- ЕГИСЗ: очередь ЭМД (ИНТ-010) ----------
  const emdQueue = await db.egiszDocument.findMany({
    where: { status: { in: ['QUEUED', 'SENT'] } },
    include: { visit: { include: { patient: true, doctor: true } } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  })
  for (const doc of emdQueue) {
    if (doc.status === 'QUEUED') {
      // отправка ЭМД в СМЭВ
      const ok = Math.random() < 0.95
      if (ok) {
        const smevId = `СМЭВ-${Date.now().toString(36).toUpperCase()}`
        await db.egiszDocument.update({
          where: { id: doc.id },
          data: { status: 'SENT', smevId, sentAt: now, attempts: doc.attempts + 1, error: null },
        })
        await logEvent({
          system: 'EGISZ',
          summary: `ЭМД отправлен в СМЭВ: визит ${doc.visitId.slice(-6).toUpperCase()}, пациент ${doc.visit?.patient.lastName ?? '—'}`,
          payload: { egiszId: doc.id, smevId, visitId: doc.visitId },
          status: 'SENT',
        })
        res.emdSent++
        res.eventsLogged++
      } else {
        await retryOrDlqEgisz(doc.id, doc.attempts, 'СМЭВ недоступен', res)
      }
    } else if (doc.status === 'SENT') {
      // подтверждение из СМЭВ (демо: сразу)
      await db.egiszDocument.update({
        where: { id: doc.id },
        data: { status: 'CONFIRMED', confirmedAt: now },
      })
      await logEvent({
        system: 'EGISZ',
        summary: `СМЭВ подтвердил регистрацию ЭМД ${doc.smevId ?? ''}`,
        payload: { egiszId: doc.id, smevId: doc.smevId },
        status: 'CONFIRMED',
      })
      res.emdConfirmed++
      res.eventsLogged++
    }
  }

  // ---------- Лаборатории (ИНТ-001) ----------
  const labQueue = await db.labReferral.findMany({
    where: { status: { in: ['CREATED', 'SENT', 'RESULT_READY'] } },
    include: { visit: { include: { patient: true } } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  })
  for (const ref of labQueue) {
    if (ref.status === 'CREATED') {
      // отправка направления в лабораторию
      const ok = Math.random() < 0.8
      if (ok) {
        await db.labReferral.update({
          where: { id: ref.id },
          data: { status: 'SENT', sentAt: now, error: null },
        })
        await logEvent({
          system: 'LAB',
          summary: `Направление в ${ref.lab} отправлено (${ref.tests ? JSON.parse(ref.tests).length : 0} исследований)`,
          payload: { referralId: ref.id, lab: ref.lab },
          status: 'SENT',
        })
        res.labsSent++
        res.eventsLogged++
      } else {
        await retryOrDlqLab(ref.id, ref.attempts ?? 0, `${ref.lab}: API недоступен`, res)
      }
    } else if (ref.status === 'SENT') {
      // повторный опрос результатов (демо: результат готов)
      await db.labReferral.update({
        where: { id: ref.id },
        data: { status: 'RESULT_READY' },
      })
      await logEvent({
        system: 'LAB',
        summary: `${ref.lab}: результаты готовы к импорту`,
        payload: { referralId: ref.id, lab: ref.lab },
        status: 'SENT',
      })
      res.labsResults++
      res.eventsLogged++
    } else if (ref.status === 'RESULT_READY') {
      // автоматический импорт результатов в ЭМК (ИНТ-001)
      const tests = safeParseTests(ref.tests)
      const resultText =
        (ref.resultText ?? '') ||
        tests.map((t) => `${t.name}: в пределах референсных значений`).join('; ') + ' — заключение: отклонений не выявлено.'
      await db.labReferral.update({
        where: { id: ref.id },
        data: { status: 'IMPORTED', resultText, importedAt: now },
      })
      await logEvent({
        system: 'LAB',
        summary: `Результаты ${ref.lab} импортированы в ЭМК пациента ${ref.visit?.patient.lastName ?? '—'}`,
        payload: { referralId: ref.id, visitId: ref.visitId },
        status: 'CONFIRMED',
      })
      res.labsImported++
      res.eventsLogged++
    }
  }

  // ---------- ДМС: реестры (ОТЧ-19) ----------
  const createdClaims = await db.dmsClaim.findMany({ where: { status: 'CREATED' }, take: 100 })
  if (createdClaims.length > 0) {
    const ok = Math.random() < 0.9
    if (ok) {
      await db.dmsClaim.updateMany({
        where: { status: 'CREATED' },
        data: { status: 'SUBMITTED', submittedAt: now },
      })
      const total = createdClaims.reduce((s, c) => s + c.amount, 0)
      await logEvent({
        system: 'DMS',
        summary: `Реестр ДМС отправлен: ${createdClaims.length} услуг на ${total} ₽ (${uniqueInsurers(createdClaims)} )`,
        payload: { claims: createdClaims.map((c) => c.id), total },
        status: 'SENT',
      })
      res.dmsSubmitted = createdClaims.length
      res.eventsLogged++
    }
  }
  // страховые ответили: часть оплатили, часть отказала
  const submitted = await db.dmsClaim.findMany({ where: { status: 'SUBMITTED' }, take: 100 })
  for (const claim of submitted) {
    if (Math.random() < 0.75) {
      await db.dmsClaim.update({ where: { id: claim.id }, data: { status: 'PAID', paidAt: now } })
    } else {
      await db.dmsClaim.update({
        where: { id: claim.id },
        data: { status: 'DENIED', denyReason: 'Диагноз не покрывается программой ДМС (демо-отказ)' },
      })
    }
    res.dmsResolved++
  }
  if (res.dmsResolved > 0) {
    await logEvent({
      system: 'DMS',
      summary: `Страховые ответили по ${res.dmsResolved} услугам: оплаты и отказы зафиксированы`,
      payload: { resolved: res.dmsResolved },
      status: 'CONFIRMED',
    })
    res.eventsLogged++
  }

  return res
}

function uniqueInsurers(claims: Array<{ insurer: string }>): string {
  return [...new Set(claims.map((c) => c.insurer))].join(', ')
}

function safeParseTests(tests: string): Array<{ code: string; name: string }> {
  try {
    return JSON.parse(tests) ?? []
  } catch {
    return []
  }
}

// Повтор по расписанию ИНТ-001: attempts → backoff; исчерпаны → DLQ
async function retryOrDlqEgisz(id: string, attempts: number, error: string, res: WorkerResult): Promise<void> {
  const next = attempts + 1
  if (next >= RETRY_MINUTES.length) {
    await db.egiszDocument.update({ where: { id }, data: { status: 'ERROR', attempts: next, error: `${error}; попытки исчерпаны — требуется ручная обработка (DLQ)` } })
    res.emdDlq++
  } else {
    await db.egiszDocument.update({
      where: { id },
      data: { attempts: next, error: `${error}; повтор №${next} через ${RETRY_MINUTES[next]} мин` },
    })
    res.emdRetried++
  }
}

async function retryOrDlqLab(id: string, attempts: number, error: string, res: WorkerResult): Promise<void> {
  const next = attempts + 1
  if (next >= RETRY_MINUTES.length) {
    await db.labReferral.update({ where: { id }, data: { status: 'ERROR', attempts: next, error: `${error}; попытки исчерпаны — DLQ` } })
    res.labsDlq++
  } else {
    await db.labReferral.update({
      where: { id },
      data: { attempts: next, error: `${error}; повтор №${next} через ${RETRY_MINUTES[next]} мин` },
    })
    res.labsRetried++
  }
}

// Телефония CTI (ИНТ-003, ФТ-011): «входящий звонок» — карточка со
// данными пациента; дедупликация event_id опускаем в демо.
export async function simulateIncomingCall(phone: string): Promise<{
  callId: string
  patientId: string | null
  patientName: string | null
  patientCard: string | null
  lastVisitAt: string | null
  appointmentsCount: number
} | null> {
  const digits = phone.replace(/\D/g, '')
  const patient = await db.patient.findFirst({
    where: { phone: { contains: digits.slice(-10) } },
  })
  const lastVisit = patient
    ? await db.visit.findFirst({ where: { patientId: patient.id }, orderBy: { createdAt: 'desc' } })
    : null
  const appointmentsCount = patient
    ? await db.appointment.count({ where: { patientId: patient.id } })
    : 0
  const call = await db.callEvent.create({
    data: {
      phone,
      patientId: patient?.id ?? null,
      direction: 'IN',
      status: 'INCOMING',
    },
  })
  await logEvent({
    system: 'TELEPHONY',
    summary: `Входящий звонок ${phone}${patient ? ` — пациент ${patient.lastName} (карта ${patient.cardNumber})` : ' — номер не распознан'}`,
    payload: { callId: call.id, phone, patientId: patient?.id ?? null },
    status: 'SENT',
  })
  return {
    callId: call.id,
    patientId: patient?.id ?? null,
    patientName: patient ? `${patient.lastName} ${patient.firstName}` : null,
    patientCard: patient?.cardNumber ?? null,
    lastVisitAt: lastVisit?.createdAt.toISOString() ?? null,
    appointmentsCount,
  }
}
