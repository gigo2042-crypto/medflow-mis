// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// SMS-адаптер. production: SMS_PROVIDER=smsru (SMSRU_API_ID[, SMSRU_FROM]) или none.
// demo: имитация доставки без отправки наружу (доля сбоев DEMO_SMS_FAIL_RATE, по умолчанию 0.12).
import { isDemo, requiredEnv } from '@/lib/config'

export interface SmsResult {
  ok: boolean
  providerId: string | null
  retryable: boolean
  error?: string
}

export interface SmsAdapter {
  name: string
  send(to: string, text: string): Promise<SmsResult>
}

export function normalizePhone(raw: string): string | null {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`
  if (d.length === 10) d = `7${d}`
  return d.length === 11 && d.startsWith('7') ? d : null
}

const demoAdapter: SmsAdapter = {
  name: 'demo',
  async send() {
    const rate = Number(process.env.DEMO_SMS_FAIL_RATE ?? '0.12')
    if (Math.random() < rate) return { ok: false, providerId: null, retryable: true, error: 'Демо: сбой канала' }
    return { ok: true, providerId: `demo-${Date.now().toString(36)}`, retryable: false }
  },
}

const noneAdapter: SmsAdapter = {
  name: 'none',
  async send() {
    return { ok: false, providerId: null, retryable: false, error: 'SMS-шлюз не настроен (SMS_PROVIDER)' }
  },
}

// SMS.ru: https://sms.ru/api/send
export const smsruAdapter: SmsAdapter = {
  name: 'smsru',
  async send(to, text) {
    const phone = normalizePhone(to)
    if (!phone) return { ok: false, providerId: null, retryable: false, error: 'Некорректный номер телефона' }
    try {
      const body = new URLSearchParams({ api_id: requiredEnv('SMSRU_API_ID'), to: phone, msg: text, json: '1' })
      if (process.env.SMSRU_FROM) body.set('from', process.env.SMSRU_FROM)
      if (process.env.SMSRU_TEST === '1') body.set('test', '1')
      const res = await fetch(process.env.SMSRU_URL || 'https://sms.ru/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return { ok: false, providerId: null, retryable: res.status >= 500, error: `SMS.ru HTTP ${res.status}` }
      const j = (await res.json()) as {
        status?: string
        status_text?: string
        sms?: Record<string, { status?: string; status_code?: number; sms_id?: string; status_text?: string }>
      }
      if (j.status !== 'OK') return { ok: false, providerId: null, retryable: true, error: j.status_text || 'SMS.ru: ошибка' }
      const r = j.sms?.[phone]
      if (!r || r.status !== 'OK') return { ok: false, providerId: null, retryable: false, error: r?.status_text || 'SMS.ru отклонил сообщение' }
      return { ok: true, providerId: r.sms_id ?? null, retryable: false }
    } catch (e) {
      return { ok: false, providerId: null, retryable: true, error: (e as Error).message }
    }
  },
}

export function smsAdapter(): SmsAdapter {
  if (isDemo()) return demoAdapter
  return process.env.SMS_PROVIDER === 'smsru' ? smsruAdapter : noneAdapter
}
