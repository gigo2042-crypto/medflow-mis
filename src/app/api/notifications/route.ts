// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { actorId, actorMeta, audit, isService, requirePerm, requireServiceOrPerm } from '@/lib/auth-server'
import { getSettings, processOutbox, quietEnd, sendManual } from '@/lib/notify'
import { clinicDayStart, normalizePhone } from '@/lib/mis-utils'
import { HIDDEN, canSeePd, maskEmail, maskPhone } from '@/lib/pd-access'
import { NotificationDTO, NotifyBlacklistDTO, NotifySettingsDTO, NotifyTemplateDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

// Центр уведомлений (ФТ-013): единый журнал исходящих сообщений —
// статусы доставки, повторные попытки, часы тишины, чёрные списки,
// лимиты тарифа, шаблоны. Доставка — POST { action: 'PROCESS' }.
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'notifications.read')
  if (!g.ok) return g.res
  try {
    const take = Math.min(Number(req.nextUrl.searchParams.get('take')) || 150, 300)
    const rows = await db.notification.findMany({ orderBy: { createdAt: 'desc' }, take })

    const settings = await getSettings()
    const now = new Date()
    const dayStart = clinicDayStart(0)
    const [sentToday, allForStats] = await Promise.all([
      db.notification.count({ where: { status: 'SENT', sentAt: { gte: dayStart } } }),
      db.notification.findMany({ select: { status: true }, take: 2000 }),
    ])
    const byStatus: Record<string, number> = {}
    for (const n of allForStats) byStatus[n.status] = (byStatus[n.status] || 0) + 1

    const qEnd = quietEnd(now, settings.quietFrom, settings.quietTo)

    const templates = await db.notificationTemplate.findMany({ orderBy: { code: 'asc' } })
    const blacklist = await db.notificationBlacklist.findMany({ orderBy: { createdAt: 'desc' } })

    // Маркетолог и др. без patients.read: журнал без ФИО, телефонов и текстов сообщений
    const pd = canSeePd(g.user)
    const dto: NotificationDTO[] = rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      channel: n.channel,
      fallbackFrom: n.fallbackFrom,
      priority: n.priority,
      patientId: n.patientId,
      patientName: pd ? n.patientName : n.patientName ? HIDDEN : null,
      phone: pd ? n.phone : n.channel === 'EMAIL' ? maskEmail(n.phone) : maskPhone(n.phone),
      text: pd ? n.text : `[${HIDDEN}: ${n.kind}]`,
      status: n.status,
      attempts: n.attempts,
      maxAttempts: n.maxAttempts,
      nextAttemptAt: n.nextAttemptAt.toISOString(),
      sentAt: n.sentAt?.toISOString() ?? null,
      error: n.error,
      externalId: n.externalId,
      createdAt: n.createdAt.toISOString(),
    }))

    const settingsDto: NotifySettingsDTO = {
      quietFrom: settings.quietFrom,
      quietTo: settings.quietTo,
      dailyLimit: settings.dailyLimit,
      retryMinutes: settings.retryMinutes,
      maxAttempts: settings.maxAttempts,
    }

    return NextResponse.json({
      notifications: dto,
      stats: {
        queued: byStatus['QUEUED'] ?? 0,
        deferredQuiet: byStatus['DEFERRED_QUIET'] ?? 0,
        sent: byStatus['SENT'] ?? 0,
        failed: byStatus['FAILED'] ?? 0,
        blockedBlacklist: byStatus['BLOCKED_BLACKLIST'] ?? 0,
        blockedLimit: byStatus['BLOCKED_LIMIT'] ?? 0,
        sentToday,
        dailyLimit: settings.dailyLimit,
        quietActive: qEnd !== null,
        quietEnd: qEnd ? qEnd.toISOString() : null,
        retryMinutes: settings.retryMinutes,
        maxAttempts: settings.maxAttempts,
      },
      settings: settingsDto,
      templates: templates.map((t): NotifyTemplateDTO => ({
        id: t.id,
        code: t.code,
        name: t.name,
        kind: t.kind,
        channel: t.channel,
        body: t.body,
        active: t.active,
      })),
      blacklist: blacklist.map((b): NotifyBlacklistDTO => ({
        id: b.id,
        phone: pd ? b.phone : maskPhone(b.phone),
        reason: b.reason,
        createdAt: b.createdAt.toISOString(),
      })),
    })
  } catch (e) {
    console.error('[notifications GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить центр уведомлений' }, { status: 500 })
  }
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const action = body.action

    // Воркер доставки: часы тишины, лимиты, повторные попытки (ФТ-013).
    // Запускается вручную из интерфейса или мини-сервисом scheduler (:3042)
    // по служебному ключу x-service-key.
    if (action === 'PROCESS') {
      const g = await requireServiceOrPerm(req, 'notifications.manage')
      if (!g.ok) return g.res
      const delivery = await processOutbox()
      if (!isService(req)) await audit('notifications.processed', actorId(g), { ...delivery })
      return NextResponse.json({ delivery })
    }

    const g = await requirePerm(req, 'notifications.manage')
    if (!g.ok) return g.res

    // Ручное сообщение пациенту (ФТ-013): SMS/мессенджеры — телефон, EMAIL — адрес (ИНТ-014)
    if (action === 'SEND_MANUAL') {
      // Ручная отправка по произвольному номеру — SMS или e-mail; MAX требует привязки пациента
      // к боту (user_id), поэтому по «голому» номеру в MAX написать нельзя
      const channel = ['SMS', 'EMAIL'].includes(body.channel) ? body.channel : 'SMS'
      const text = String(body.text || '').trim()
      if (text.length < 3) {
        return NextResponse.json({ error: 'Укажите текст сообщения' }, { status: 400 })
      }
      let recipient: string
      if (channel === 'EMAIL') {
        recipient = String(body.phone || '').trim()
        if (!EMAIL_RE.test(recipient)) {
          return NextResponse.json({ error: 'Для канала EMAIL укажите адрес получателя' }, { status: 400 })
        }
      } else {
        recipient = normalizePhone(String(body.phone || ''))
        if (recipient.length < 10) {
          return NextResponse.json({ error: 'Укажите телефон (не короче 10 цифр)' }, { status: 400 })
        }
      }
      const res = await sendManual({ phone: recipient, text, channel })
      await audit('notifications.manual_sent', g.user.id, { phone: recipient, channel, status: res.status })
      if (res.status === 'BLOCKED_BLACKLIST') {
        return NextResponse.json({ error: 'Телефон в чёрном списке центра уведомлений' }, { status: 400 })
      }
      return NextResponse.json({ ok: true, status: res.status })
    }

    // Чёрный список: добавить / исключить телефон (ФТ-013)
    if (action === 'TOGGLE_BLACKLIST') {
      const phone = normalizePhone(String(body.phone || ''))
      if (phone.length < 10) return NextResponse.json({ error: 'Укажите телефон (не короче 10 цифр)' }, { status: 400 })
      if (body.remove) {
        await db.notificationBlacklist.deleteMany({ where: { phone } })
        await audit('notifications.blacklist_removed', g.user.id, { phone })
        return NextResponse.json({ ok: true, removed: true })
      }
      const reason = String(body.reason || '').trim() || null
      const existing = await db.notificationBlacklist.findUnique({ where: { phone } })
      if (existing) {
        await db.notificationBlacklist.update({ where: { phone }, data: { reason } })
      } else {
        await db.notificationBlacklist.create({ data: { phone, reason } })
      }
      await audit('notifications.blacklist_added', g.user.id, { phone, reason })
      return NextResponse.json({ ok: true })
    }

    // Настройки: часы тишины, лимит тарифа, ретраи (ФТ-013)
    if (action === 'UPDATE_SETTINGS') {
      const quietFrom = String(body.quietFrom || '')
      const quietTo = String(body.quietTo || '')
      if (!HHMM_RE.test(quietFrom) || !HHMM_RE.test(quietTo)) {
        return NextResponse.json({ error: 'Часы тишины — в формате ЧЧ:ММ' }, { status: 400 })
      }
      const dailyLimit = Number(body.dailyLimit)
      const retryMinutes = Number(body.retryMinutes)
      const maxAttempts = Number(body.maxAttempts)
      if (!(dailyLimit >= 1 && dailyLimit <= 100000)) return NextResponse.json({ error: 'Лимит: 1..100000 сообщений/сутки' }, { status: 400 })
      if (!(retryMinutes >= 1 && retryMinutes <= 120)) return NextResponse.json({ error: 'Интервал повтора: 1..120 минут' }, { status: 400 })
      if (!(maxAttempts >= 1 && maxAttempts <= 10)) return NextResponse.json({ error: 'Попыток доставки: 1..10' }, { status: 400 })
      await getSettings() // гарантирует singleton-строку
      await db.notificationSetting.update({
        where: { id: 'main' },
        data: { quietFrom, quietTo, dailyLimit, retryMinutes, maxAttempts },
      })
      await audit('notifications.settings_updated', g.user.id, { quietFrom, quietTo, dailyLimit, retryMinutes, maxAttempts })
      return NextResponse.json({ ok: true })
    }

    // Шаблоны сообщений (ФТ-013)
    if (action === 'UPDATE_TEMPLATE') {
      if (!body.id) return NextResponse.json({ error: 'Укажите id шаблона' }, { status: 400 })
      const t = await db.notificationTemplate.findUnique({ where: { id: body.id } })
      if (!t) return NextResponse.json({ error: 'Шаблон не найден' }, { status: 404 })
      const bodyText = body.body !== undefined ? String(body.body) : undefined
      if (bodyText !== undefined && bodyText.trim().length < 5) {
        return NextResponse.json({ error: 'Текст шаблона слишком короткий' }, { status: 400 })
      }
      const active = typeof body.active === 'boolean' ? body.active : undefined
      await db.notificationTemplate.update({
        where: { id: t.id },
        data: { body: bodyText ?? undefined, active },
      })
      await audit('notifications.template_updated', g.user.id, { code: t.code, active })
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 })
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE')) {
      return NextResponse.json({ error: 'Дубликат: такой телефон уже в списке' }, { status: 400 })
    }
    console.error('[notifications POST]', e)
    return NextResponse.json({ error: 'Не удалось выполнить действие' }, { status: 500 })
  }
}
