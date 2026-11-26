// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireService } from '@/lib/auth-server'
import { logEvent } from '@/lib/integrations'
import { staffAlert } from '@/lib/notify'

export const dynamic = 'force-dynamic'

// Webhook email-провайдера (ИНТ-014): финальные статусы доставки писем.
// Финальный сбой после 3 попыток (включая резервный SMTP) возвращается
// в Центр уведомлений (ФТ-013) как EMAIL_FALLBACK для администратора.
export async function POST(req: NextRequest) {
  const g = requireService(req)
  if (!g.ok) return g.res
  try {
    const body = (await req.json()) as {
      id: string // id сообщения у провайдера
      status: 'DELIVERED' | 'FAILED' | 'BOUNCED'
      to: string
      subject: string
      category: string
      attempts: number
      meta?: Record<string, unknown>
    }
    if (!body.id || !body.status) {
      return NextResponse.json({ error: 'Некорректный webhook' }, { status: 400 })
    }

    // Синхронизация с центром уведомлений (если письмо отсюда)
    if (body.meta?.notificationId) {
      await db.notification.update({
        where: { id: String(body.meta.notificationId) },
        data: {
          error: body.status === 'DELIVERED' ? null : `Email-провайдер: не доставлено (попыток ${body.attempts})`,
        },
      }).catch(() => undefined)
    }

    // Статус письма регулярного отчёта
    if (body.meta?.runId && body.meta?.scheduleId) {
      const failed = body.status !== 'DELIVERED'
      await db.reportRun
        .update({
          where: { id: String(body.meta.runId) },
          data: failed ? { emailStatus: 'FAILED', error: `Письмо отчёта не доставлено: ${body.to}` } : { emailStatus: 'SENT' },
        })
        .catch(() => undefined)
    }

    await logEvent({
      system: 'EMAIL',
      direction: 'IN',
      summary:
        body.status === 'DELIVERED'
          ? `Провайдер доставил письмо «${body.subject}» → ${body.to} (${body.category})`
          : `Провайдер НЕ доставил «${body.subject}» → ${body.to} после ${body.attempts} попыток`,
      payload: { providerId: body.id, to: body.to, subject: body.subject, category: body.category, status: body.status, meta: body.meta ?? {} },
      status: body.status === 'DELIVERED' ? 'CONFIRMED' : 'ERROR',
    })

    // ТЗ ИНТ-014: 3 попытки исчерпаны → сообщение уходит в Центр уведомлений
    if (body.status !== 'DELIVERED') {
      await staffAlert(
        'EMAIL_FALLBACK',
        `Email не доставлен: «${body.subject}» → ${body.to}. Провайдер исчерпал 3 попытки (вкл. резервный SMTP) — свяжитесь с получателем или повторите позже.`
      )
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[integrations/email/webhook POST]', e)
    return NextResponse.json({ error: 'Ошибка обработки webhook' }, { status: 500 })
  }
}
