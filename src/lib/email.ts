// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Email-адаптер (ИНТ-014): транзакционные письма — уведомления, отчёты, приглашения.
//   production: EMAIL_PROVIDER=smtp (SMTP_HOST/PORT/USER/PASS/FROM/SECURE) или none
//   demo:       мини-сервис email-provider (компоуз демо), наружу ничего не уходит
// Серверный модуль — не импортировать в клиентский код!
import nodemailer, { Transporter } from 'nodemailer'
import { isDemo, requiredEnv } from '@/lib/config'

const SEND_TIMEOUT_MS = 10000

export interface EmailSendInput {
  to: string
  subject: string
  html: string
  category?: string // REMINDER | WAITLIST_OFFER | REPORT | DOC | SECURITY | MANUAL
  attachment?: { filename: string; base64: string }
  meta?: Record<string, unknown>
}

export interface EmailSendResult {
  ok: boolean
  providerId: string | null
  status: string // SENT | QUEUED | UNREACHABLE | REJECTED | DISABLED
  error?: string
}

export type EmailProvider = 'demo' | 'smtp' | 'none'

export function emailProvider(): EmailProvider {
  if (isDemo()) return 'demo'
  return process.env.EMAIL_PROVIDER === 'smtp' ? 'smtp' : 'none'
}

export function isEmailProviderConfigured(): boolean {
  return emailProvider() !== 'none'
}

let transporter: Transporter | null = null

function smtp(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: requiredEnv('SMTP_HOST'),
      port: Number(requiredEnv('SMTP_PORT')),
      secure: process.env.SMTP_SECURE === '1' || process.env.SMTP_PORT === '465',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    })
  }
  return transporter
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

export async function sendEmail(input: EmailSendInput): Promise<EmailSendResult> {
  if (!EMAIL_RE.test(String(input.to || ''))) {
    return { ok: false, providerId: null, status: 'REJECTED', error: 'Некорректный адрес получателя' }
  }
  const p = emailProvider()
  if (p === 'none') return { ok: false, providerId: null, status: 'DISABLED', error: 'Отправка e-mail не настроена (EMAIL_PROVIDER)' }
  if (p === 'smtp') {
    try {
      const info = await smtp().sendMail({
        from: requiredEnv('SMTP_FROM'),
        to: input.to,
        subject: input.subject,
        html: input.html,
        attachments: input.attachment
          ? [{ filename: input.attachment.filename, content: Buffer.from(input.attachment.base64, 'base64') }]
          : undefined,
      })
      return { ok: true, providerId: info.messageId ?? null, status: 'SENT' }
    } catch (e) {
      const code = (e as { responseCode?: number }).responseCode
      // 5xx SMTP — постоянная ошибка; сеть/4xx — повтор по правилам центра уведомлений
      if (code && code >= 500) return { ok: false, providerId: null, status: 'REJECTED', error: `SMTP ${code}` }
      return { ok: false, providerId: null, status: 'UNREACHABLE', error: (e as Error).message }
    }
  }
  // demo: мини-сервис-заглушка внутри компоуза, наружу письма не уходят
  try {
    const res = await fetch(`${process.env.EMAIL_PROVIDER_URL || 'http://localhost:3040'}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': requiredEnv('SERVICE_KEY') },
      body: JSON.stringify({
        to: input.to,
        subject: input.subject,
        html: input.html,
        category: input.category ?? 'MANUAL',
        attachment: input.attachment ?? undefined,
        meta: input.meta ?? {},
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    const data = (await res.json().catch(() => ({}))) as { id?: string; status?: string; error?: string }
    if (!res.ok) return { ok: false, providerId: data.id ?? null, status: 'REJECTED', error: data.error ?? `HTTP ${res.status}` }
    return { ok: true, providerId: data.id ?? null, status: data.status ?? 'QUEUED' }
  } catch (e) {
    return { ok: false, providerId: null, status: 'UNREACHABLE', error: (e as Error).message }
  }
}

/** Экранирование пользовательских данных при вставке в HTML письма (чеклист п.15). */
export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
