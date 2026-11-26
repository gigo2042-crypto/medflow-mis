// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Центр уведомлений (ФТ-013, v1): единый исходящий контур МИС.
// Через него доставляются напоминания (ФТ-005), приглашения из листа
// ожидания (ТУ-004) и ручные сообщения. Управление: часы тишины,
// чёрные списки, лимит тарифа, повторные попытки, шаблоны.
// Серверный модуль — не импортировать в клиентский код!

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { isDemo } from '@/lib/config'
import { smsAdapter } from '@/lib/sms'
import { addDaysKey, clinicDayStart, clinicMinutes, dateKey, minutesOf, normalizePhone, parseDateKey, zonedTime } from './mis-utils'
import { escapeHtml, sendEmail } from './email'
import { clinicBrand } from './clinic'
import { maxConfig, sendMaxMessage, type MaxButton } from './max'
import { signLink } from './patient-links'

export type NotifyKind = 'REMINDER' | 'WAITLIST_OFFER' | 'RISK_TOUCH' | 'MANUAL' | 'STOCK_LOW' | 'EMAIL_FALLBACK' | 'CAMPAIGN'

export interface DeliveryCounts {
  sent: number
  failed: number
  retrying: number
  deferredQuiet: number
  blockedLimit: number
}

// ---------- Настройки (singleton) ----------

export interface NotifySettingsData {
  quietFrom: string
  quietTo: string
  dailyLimit: number
  retryMinutes: number
  maxAttempts: number
}

export async function getSettings(): Promise<NotifySettingsData> {
  const s = await db.notificationSetting.findUnique({ where: { id: 'main' } })
  if (s) return s
  const created = await db.notificationSetting.create({ data: { id: 'main' } })
  return created
}

// ---------- Часы тишины (ФТ-013) ----------

// Если текущий момент внутри окна тишины — вернуть момент его окончания, иначе null.
// Окно может пересекать полночь (21:00–09:00).
export function quietEnd(now: Date, quietFrom: string, quietTo: string): Date | null {
  const m = clinicMinutes(now)
  const f = minutesOf(quietFrom)
  const t = minutesOf(quietTo)
  const inWindow = f <= t ? m >= f && m < t : m >= f || m < t
  if (!inWindow) return null
  // Окончание окна — в поясе клиники: сегодня (утро) или завтра (вечер) в quietTo
  const key = m < t ? dateKey(now) : addDaysKey(dateKey(now), 1)
  const k = parseDateKey(key)!
  return zonedTime(k.y, k.m, k.d, Math.floor(t / 60), t % 60)
}

// ---------- Шаблоны (ФТ-013) ----------

// Подстановка {{ключ}} в теле шаблона; неизвестные плейсхолдеры остаются как есть.
export function renderBody(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (orig, key: string) => vars[key] ?? orig)
}

// Рендер активного шаблона по коду; null — шаблона нет или он выключен.
export async function renderTemplate(code: string, vars: Record<string, string>): Promise<string | null> {
  const t = await db.notificationTemplate.findUnique({ where: { code } })
  if (!t || !t.active) return null
  return renderBody(t.body, vars)
}

// ---------- Очередь исходящих ----------

export interface EnqueueInput {
  kind: NotifyKind
  channel: string
  phone: string
  text: string
  patientId?: string | null
  patientName?: string | null
  priority?: number // 1 — срочное: в обход часам тишины
  relatedAppointmentId?: string | null
  relatedReminderId?: string | null
  relatedWaitingId?: string | null
}

// Постановка сообщения в очередь центра уведомлений.
// Телефон в чёрном списке помечается BLOCKED_BLACKLIST сразу (ФТ-013).
export async function enqueue(input: EnqueueInput): Promise<{ id: string; status: string }> {
  const settings = await getSettings()
  const phone = normalizePhone(input.phone)
  const blocked = phone ? await db.notificationBlacklist.findUnique({ where: { phone } }) : null
  const status = blocked ? 'BLOCKED_BLACKLIST' : 'QUEUED'
  const n = await db.notification.create({
    data: {
      kind: input.kind,
      channel: input.channel,
      priority: input.priority ?? 0,
      patientId: input.patientId ?? null,
      patientName: input.patientName ?? null,
      phone: input.phone,
      text: input.text,
      status,
      maxAttempts: settings.maxAttempts,
      nextAttemptAt: new Date(),
      error: blocked ? `Чёрный список: ${blocked.reason ?? 'без детали'}` : null,
      relatedAppointmentId: input.relatedAppointmentId ?? null,
      relatedReminderId: input.relatedReminderId ?? null,
      relatedWaitingId: input.relatedWaitingId ?? null,
    },
  })
  return { id: n.id, status }
}

// Тема письма по типу сообщения (ИНТ-014)
function emailSubject(kind: string, patientName: string | null): string {
  switch (kind) {
    case 'REMINDER':
      return `Напоминание о приёме — ${clinicBrand()}${patientName ? ` · ${patientName}` : ''}`
    case 'WAITLIST_OFFER':
      return `Освободилось время — приглашение из листа ожидания${patientName ? ` · ${patientName}` : ''}`
    case 'RISK_TOUCH':
      return `Контроль записи — ${clinicBrand()}${patientName ? ` · ${patientName}` : ''}`
    default:
      return `Сообщение — ${clinicBrand()}`
  }
}

// Захват пачки сообщений воркером (защита от двойной отправки):
// UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) — параллельный воркер
// (планировщик + ручной PROCESS + sendManual) не получит те же строки.
// Захват живёт LOCK_MINUTES: если воркер упал посреди отправки, сообщение
// вернётся в работу после истечения (возможен один повтор — это лучше потери).
const LOCK_MINUTES = 5

export async function claimDue(limit: number, now: Date = new Date()): Promise<string[]> {
  const lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60_000)
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "Notification" SET "status" = 'SENDING', "lockedUntil" = ${lockedUntil}
    WHERE "id" IN (
      SELECT "id" FROM "Notification"
      WHERE ("status" IN ('QUEUED', 'DEFERRED_QUIET') AND "nextAttemptAt" <= ${now})
         OR ("status" = 'SENDING' AND "lockedUntil" < ${now})
      ORDER BY "priority" DESC, "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"`
  return rows.map((r) => r.id)
}

type ChannelResult = { ok: boolean; providerId: string | null; retryable: boolean; error?: string | null }

// Кнопки ответа в MAX: напоминания, касания по риску и приглашения из листа ожидания
function maxButtonsFor(n: { kind: string; relatedAppointmentId: string | null; relatedWaitingId: string | null }): MaxButton[] | undefined {
  if ((n.kind === 'REMINDER' || n.kind === 'RISK_TOUCH') && n.relatedAppointmentId) {
    const t = signLink('ap', n.relatedAppointmentId)
    return [{ text: 'Подтверждаю', payload: `ok:${t}` }, { text: 'Отменить', payload: `no:${t}` }]
  }
  if (n.kind === 'WAITLIST_OFFER' && n.relatedWaitingId) {
    const t = signLink('wl', n.relatedWaitingId)
    return [{ text: 'Записаться', payload: `ok:${t}` }, { text: 'Не подходит', payload: `no:${t}` }]
  }
  return undefined
}

// «Воркер» доставки: обрабатывает сообщения, время которых пришло.
// 1) несрочные откладываются до конца окна тишины; 2) при исчерпании
// дневного лимита тарифа помечаются BLOCKED_LIMIT; 3) сбой канала —
// повторные попытки (не более maxAttempts) с интервалом retryMinutes.
// Канал MAX: если бот не настроен или пациент не привязан — фолбэк на SMS.
// Демо-канал: ~88% доставок успешны, остальные дают ретраи/ошибки.
export async function processOutbox(limit = 100): Promise<DeliveryCounts> {
  const settings = await getSettings()
  const now = new Date()
  const counts: DeliveryCounts = { sent: 0, failed: 0, retrying: 0, deferredQuiet: 0, blockedLimit: 0 }

  const dayStart = clinicDayStart(0)
  const sentToday = await db.notification.count({ where: { status: 'SENT', sentAt: { gte: dayStart } } })
  let budget = Math.max(0, settings.dailyLimit - sentToday)

  const ids = await claimDue(limit, now)
  if (ids.length === 0) return counts
  const due = await db.notification.findMany({
    where: { id: { in: ids } },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  })

  const done = async (id: string, data: Prisma.NotificationUpdateInput) =>
    db.notification.update({ where: { id }, data: { ...data, lockedUntil: null } })

  for (const n of due) {
    // Часы тишины: несрочные сообщения не отправляются ночью (ФТ-013)
    if (n.priority < 1) {
      const qEnd = quietEnd(now, settings.quietFrom, settings.quietTo)
      if (qEnd) {
        await done(n.id, { status: 'DEFERRED_QUIET', nextAttemptAt: qEnd, error: `Часы тишины ${settings.quietFrom}–${settings.quietTo}: отправка отложена` })
        counts.deferredQuiet++
        continue
      }
    }

    // Лимит тарифа (ФТ-013): дневной бюджет сообщений исчерпан
    if (budget <= 0) {
      await done(n.id, { status: 'BLOCKED_LIMIT', error: `Дневной лимит тарифа (${settings.dailyLimit}) исчерпан` })
      counts.blockedLimit++
      continue
    }

    let result: ChannelResult
    let channel = n.channel
    let fallbackFrom: string | null = n.fallbackFrom

    if (channel === 'EMAIL') {
      // Канал EMAIL (ИНТ-014): провайдер сам делает 3 попытки с fallback SMTP
      const res = await sendEmail({
        to: n.phone, // для EMAIL здесь адрес получателя
        subject: emailSubject(n.kind, n.patientName),
        html: `<p style="font-family:Arial,sans-serif;font-size:14px">${escapeHtml(n.text)}</p>`,
        category: n.kind,
        meta: { notificationId: n.id, relatedReminderId: n.relatedReminderId, relatedWaitingId: n.relatedWaitingId },
      })
      result = res.ok
        ? { ok: true, providerId: res.providerId, retryable: false }
        : { ok: false, providerId: null, retryable: res.status === 'UNREACHABLE', error: res.status === 'UNREACHABLE' ? 'Email-провайдер недоступен' : res.error ?? 'Провайдер отклонил письмо' }
    } else {
      if (channel === 'MAX') {
        const patient = n.patientId ? await db.patient.findUnique({ where: { id: n.patientId }, select: { maxUserId: true } }) : null
        const cfg = maxConfig()
        if (patient?.maxUserId && (cfg.configured || isDemo())) {
          result = isDemo()
            ? await smsAdapter().send(n.phone, n.text) // демо: имитация доставки, наружу ничего не уходит
            : await sendMaxMessage(patient.maxUserId, n.text, maxButtonsFor(n))
          if (!result.ok && !result.retryable) {
            // постоянная ошибка MAX (пользователь остановил бота и т.п.) — сразу SMS
            fallbackFrom = 'MAX'
            channel = 'SMS'
          }
        } else {
          fallbackFrom = 'MAX'
          channel = 'SMS'
          result = { ok: false, providerId: null, retryable: false }
        }
      } else {
        result = { ok: false, providerId: null, retryable: false }
      }
      if (channel === 'SMS') {
        result = await smsAdapter().send(n.phone, n.text)
      } else if (channel !== 'MAX') {
        result = { ok: false, providerId: null, retryable: false, error: `Канал ${channel} не подключён` }
      }
    }

    const attempts = n.attempts + 1
    if (result.ok) {
      await done(n.id, { status: 'SENT', sentAt: now, attempts, error: null, externalId: result.providerId, channel, fallbackFrom })
      // статус напоминания следует за доставкой сразу, без отдельной синхронизации
      if (n.relatedReminderId) {
        await db.reminder.updateMany({ where: { id: n.relatedReminderId, status: 'PLANNED' }, data: { status: 'SENT', sentAt: now } })
      }
      budget--
      counts.sent++
    } else if (!result.retryable || attempts >= n.maxAttempts) {
      await done(n.id, {
        status: 'FAILED', attempts, channel, fallbackFrom,
        error: result.retryable ? 'Канал недоступен: попытки исчерпаны' : result.error ?? 'Отклонено',
      })
      if (n.relatedReminderId) {
        await db.reminder.updateMany({ where: { id: n.relatedReminderId, status: 'PLANNED' }, data: { status: 'FAILED' } })
      }
      counts.failed++
    } else {
      await done(n.id, {
        status: 'QUEUED', attempts, channel, fallbackFrom,
        nextAttemptAt: new Date(now.getTime() + settings.retryMinutes * 60_000),
        error: `Сбой доставки — повтор №${attempts + 1} через ${settings.retryMinutes} мин${result.error ? ` (${result.error})` : ''}`,
      })
      counts.retrying++
    }
  }
  return counts
}

// Досинхронизация статусов напоминаний (на случай сбоя между отправкой и обновлением):
// только недавние сообщения, по индексу, без полного прохода по журналу
export async function syncReminderStatuses(): Promise<number> {
  const since = new Date(Date.now() - 3 * 24 * 3600_000)
  const rows = await db.notification.findMany({
    where: { kind: 'REMINDER', status: { in: ['SENT', 'FAILED'] }, relatedReminderId: { not: null }, createdAt: { gte: since } },
    select: { relatedReminderId: true, status: true, sentAt: true },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  })
  let synced = 0
  for (const r of rows) {
    const upd = await db.reminder.updateMany({
      where: { id: r.relatedReminderId!, status: 'PLANNED' },
      data: r.status === 'SENT' ? { status: 'SENT', sentAt: r.sentAt } : { status: 'FAILED' },
    })
    synced += upd.count
  }
  return synced
}

// ---------- Ручная отправка (ФТ-013) ----------

export async function sendManual(input: {
  phone: string
  text: string
  channel: string
  patientId?: string | null
  patientName?: string | null
}): Promise<{ id: string; status: string }> {
  const queued = await enqueue({
    kind: 'MANUAL',
    channel: input.channel,
    phone: input.phone,
    text: input.text,
    patientId: input.patientId ?? null,
    patientName: input.patientName ?? null,
  })
  if (queued.status === 'QUEUED') {
    // немедленная попытка доставки
    await db.notification.update({ where: { id: queued.id }, data: { nextAttemptAt: new Date() } })
    await processOutbox(20)
    const fresh = await db.notification.findUnique({ where: { id: queued.id } })
    return { id: queued.id, status: fresh?.status ?? queued.status }
  }
  return queued
}

// ---------- Служебные оповещения персонала ----------
// Склад ниже минимума, недоставленные письма и т.п. Если задан STAFF_ALERT_EMAIL —
// письмо ответственному; иначе запись только в журнале Центра уведомлений (статус INBOX),
// без отправки на выдуманный телефон.
export async function staffAlert(kind: NotifyKind, text: string): Promise<{ id: string; status: string }> {
  const to = (process.env.STAFF_ALERT_EMAIL || '').trim()
  if (to) return enqueue({ kind, channel: 'EMAIL', phone: to, text, priority: 1 })
  const n = await db.notification.create({
    data: { kind, channel: 'INBOX', phone: '—', text, status: 'INBOX', priority: 1, error: 'STAFF_ALERT_EMAIL не задан — только в журнале' },
  })
  return { id: n.id, status: n.status }
}
