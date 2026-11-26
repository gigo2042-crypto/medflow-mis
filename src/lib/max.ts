// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Мессенджер MAX (Bot API, https://dev.max.ru/docs-api) — замена WhatsApp.
// Сверено с официальной документацией:
//   • базовый адрес https://platform-api2.max.ru, токен — заголовок «Authorization: <token>»
//     (передача токена в query больше не поддерживается);
//   • POST /messages?user_id=<id> — сообщение пользователю; text до 4000 символов;
//     не более 2 сообщений в секунду в один диалог;
//   • бот НЕ может написать по номеру телефона: user_id становится известен только после того,
//     как пользователь сам запустил бота (событие bot_started; payload — из диплинка
//     https://max.ru/<имя_бота>?start=<payload>);
//   • вебхук: POST /subscriptions {url, update_types, secret}; secret ^[a-zA-Z0-9_-]{5,256}$,
//     приходит в заголовке X-Max-Bot-Api-Secret; только HTTPS на порту 443;
//   • кнопки: attachments[{type:'inline_keyboard', payload:{buttons:[[{type:'callback', text, payload}]]}}],
//     нажатие приходит событием message_callback (callback.callback_id, callback.payload),
//     ответ — POST /answers?callback_id=<id> {message?: NewMessageBody}.
// Не проверено вживую (нет токена бота): реальные коды ошибок для заблокировавшего бота
// пользователя — поэтому любой 4xx, кроме 429, считаем постоянной ошибкой с фолбэком на SMS.
import { isDemo } from '@/lib/config'

export interface MaxConfig {
  configured: boolean
  problem: string | null
  token: string
  botName: string
  webhookSecret: string
  apiUrl: string
}

export const MAX_SECRET_RE = /^[a-zA-Z0-9_-]{5,256}$/

export function maxConfig(env: Record<string, string | undefined> = process.env): MaxConfig {
  const token = env.MAX_BOT_TOKEN || ''
  const botName = (env.MAX_BOT_NAME || '').replace(/^@/, '')
  const webhookSecret = env.MAX_WEBHOOK_SECRET || ''
  const apiUrl = (env.MAX_API_URL || 'https://platform-api2.max.ru').replace(/\/+$/, '')
  const missing = [!token && 'MAX_BOT_TOKEN', !botName && 'MAX_BOT_NAME', !webhookSecret && 'MAX_WEBHOOK_SECRET'].filter(Boolean)
  let problem: string | null = null
  if (missing.length) problem = `MAX не подключён: не заданы ${missing.join(', ')} — сообщения уходят по SMS`
  else if (!MAX_SECRET_RE.test(webhookSecret)) problem = 'MAX_WEBHOOK_SECRET: 5–256 символов [a-zA-Z0-9_-] (требование MAX)'
  return { configured: !problem, problem, token, botName, webhookSecret, apiUrl }
}

/** Диплинк для привязки: пациент открывает его, жмёт «Начать» — приходит bot_started с payload. */
export function maxDeeplink(payload: string, env: Record<string, string | undefined> = process.env): string | null {
  const c = maxConfig(env)
  const name = c.botName || (isDemo() ? 'medflow_demo_bot' : '')
  if (!name) return null
  return `https://max.ru/${encodeURIComponent(name)}?start=${encodeURIComponent(payload)}`
}

export interface MaxButton {
  text: string
  payload: string
}

export interface MaxSendResult {
  ok: boolean
  providerId: string | null
  retryable: boolean
  error: string | null
}

export const MAX_TEXT_LIMIT = 4000

export function buildMaxMessage(text: string, buttons?: MaxButton[]): Record<string, unknown> {
  const body: Record<string, unknown> = { text: text.slice(0, MAX_TEXT_LIMIT) }
  if (buttons?.length) {
    body.attachments = [
      {
        type: 'inline_keyboard',
        payload: { buttons: [buttons.map((b) => ({ type: 'callback', text: b.text.slice(0, 128), payload: b.payload.slice(0, 1024) }))] },
      },
    ]
  }
  return body
}

async function maxCall(path: string, body: unknown, fetchImpl: typeof fetch): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const c = maxConfig()
  if (!c.configured) throw new Error(c.problem || 'MAX не настроен')
  const res = await fetchImpl(`${c.apiUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: c.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { status: res.status, json }
}

/** Отправка сообщения пользователю по user_id. */
export async function sendMaxMessage(userId: string, text: string, buttons?: MaxButton[], fetchImpl: typeof fetch = fetch): Promise<MaxSendResult> {
  if (!/^\d+$/.test(userId)) return { ok: false, providerId: null, retryable: false, error: 'Некорректный MAX user_id' }
  try {
    const { status, json } = await maxCall(`/messages?user_id=${userId}`, buildMaxMessage(text, buttons), fetchImpl)
    const msg = (json?.message ?? null) as { body?: { mid?: string } } | null
    if (status === 200 && msg) return { ok: true, providerId: msg.body?.mid ?? null, retryable: false, error: null }
    const code = typeof json?.code === 'string' ? json.code : String(status)
    const text2 = typeof json?.message === 'string' ? json.message : ''
    const retryable = status === 429 || status >= 500
    return { ok: false, providerId: null, retryable, error: `MAX ${status} ${code}${text2 ? `: ${text2}` : ''}`.slice(0, 300) }
  } catch (e) {
    return { ok: false, providerId: null, retryable: true, error: `MAX недоступен: ${(e as Error).message}`.slice(0, 300) }
  }
}

/** Ответ на нажатие кнопки: заменяет текст исходного сообщения (кнопки убираются). */
export async function answerMaxCallback(callbackId: string, text: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const { status, json } = await maxCall(`/answers?callback_id=${encodeURIComponent(callbackId)}`, { message: { text: text.slice(0, MAX_TEXT_LIMIT), attachments: [] } }, fetchImpl)
    return status === 200 && json?.success !== false
  } catch {
    return false
  }
}
