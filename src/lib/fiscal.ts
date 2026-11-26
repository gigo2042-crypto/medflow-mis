// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Фискализация 54-ФЗ через облачную кассу АТОЛ Онлайн, протокол v5 (ФФД 1.2).
// Сверено с официальным описанием «API_atol_online_v5.pdf» (atol.online):
//  • POST {base}/getToken {login, pass} → {token, error, timestamp}; токен живёт 24 ч,
//    повторно запрашивать только при ошибке ExpiredToken (HTTP 401, code 11);
//  • POST {base}/{group_code}/{sell|sell_refund}, заголовок Token, тело
//    {timestamp "дд.мм.гггг чч:мм:сс", external_id, receipt{client{email|phone}, company{email, sno, inn,
//    payment_address}, items[{name≤128, price, quantity, measure 0, sum, payment_method "full_payment",
//    payment_object 4 (услуга), vat{type}}], payments[{type 0 нал / 1 безнал, sum}], total}}
//    → {uuid, status "wait"} либо {error{code,text}}; code 33 — external_id уже зарегистрирован;
//  • GET {base}/{group_code}/report/{uuid} (Token) → status wait|done|fail, payload {fiscal_receipt_number,
//    shift_number, receipt_datetime, total, fn_number, ecr_registration_number, fiscal_document_number,
//    fiscal_document_attribute, fns_site, ofd_inn, ofd_receipt_url?}.
// Включается FISCAL_PROVIDER=atol. Без настроек — явная ошибка (не тихий 501) и предупреждение в кассе.
// Серверный модуль — не импортировать в клиентский код!
import { isDemo } from '@/lib/config'
import { clinic } from '@/lib/clinic'

export type FiscalOperation = 'sell' | 'sell_refund'

export interface FiscalStatus {
  provider: 'atol' | 'demo' | 'none'
  configured: boolean
  demo: boolean
  problem: string | null
}

const ATOL_REQUIRED = ['ATOL_LOGIN', 'ATOL_PASSWORD', 'ATOL_GROUP_CODE', 'ATOL_SNO', 'ATOL_PAYMENT_ADDRESS', 'ATOL_COMPANY_EMAIL'] as const
const SNO = ['osn', 'usn_income', 'usn_income_outcome', 'esn', 'patent'] // envd отменён с 2021 г.
// ставки из описания v5 (док. 3.0) + vat22/vat122 по статье базы знаний АТОЛ help.atol.online/article/26152
const VAT = ['none', 'vat0', 'vat10', 'vat110', 'vat20', 'vat120', 'vat22', 'vat122']

export function fiscalStatus(env: Record<string, string | undefined> = process.env): FiscalStatus {
  if (isDemo()) return { provider: 'demo', configured: true, demo: true, problem: null }
  if (env.FISCAL_PROVIDER !== 'atol') {
    return { provider: 'none', configured: false, demo: false, problem: 'Онлайн-касса не подключена (FISCAL_PROVIDER не задан). Чеки 54-ФЗ не формируются — выдавайте чек с аппаратной ККТ.' }
  }
  const missing = ATOL_REQUIRED.filter((k) => !env[k])
  if (!env.CLINIC_INN) missing.push('CLINIC_INN' as never)
  if (missing.length) return { provider: 'atol', configured: false, demo: false, problem: `АТОЛ Онлайн: не заданы ${missing.join(', ')}` }
  if (!SNO.includes(String(env.ATOL_SNO))) return { provider: 'atol', configured: false, demo: false, problem: `ATOL_SNO: одно из ${SNO.join(', ')}` }
  if (env.ATOL_VAT && !VAT.includes(env.ATOL_VAT)) return { provider: 'atol', configured: false, demo: false, problem: `ATOL_VAT: одно из ${VAT.join(', ')}` }
  return { provider: 'atol', configured: true, demo: false, problem: null }
}

export class FiscalNotConfiguredError extends Error {}

// ---------- Формирование чека ----------

export interface FiscalItem {
  name: string
  price: number // руб. за единицу до скидки
  qty: number
}

export interface FiscalInput {
  externalId: string
  operation: FiscalOperation
  items: FiscalItem[]
  discount: number // руб., на весь чек
  method: string // CASH | CARD | SBP
  client: { email?: string | null; phone?: string | null }
  cashier?: string | null
  at?: Date
}

/** «дд.мм.гггг чч:мм:сс» в поясе клиники — формат поля timestamp АТОЛ. */
export function atolTimestamp(d: Date, tz = process.env.CLINIC_TZ || 'Europe/Moscow'): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('ru-RU', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  )
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`
}

/** +79991234567 из произвольного ввода; null — не российский мобильный формат. */
export function e164ru(raw: string | null | undefined): string | null {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`
  if (d.length === 10) d = `7${d}`
  return d.length === 11 && d.startsWith('7') ? `+${d}` : null
}

/**
 * Скидка распределяется по позициям (АТОЛ: price — «с учётом скидок»), в копейках,
 * так, чтобы price × quantity = sum для каждой строки. Если остаток не делится на
 * количество — от строки отделяется одна единица с отдельной ценой.
 */
export function applyDiscount(items: FiscalItem[], discountRub: number): Array<{ name: string; price: number; quantity: number; sum: number }> {
  const lines = items.map((i) => ({ name: i.name, unit: Math.round(i.price * 100), qty: Math.max(1, Math.round(i.qty)) }))
  const gross = lines.reduce((s, l) => s + l.unit * l.qty, 0)
  let left = Math.max(0, Math.min(gross, Math.round(discountRub * 100)))
  const perUnitOff = lines.map(() => 0)
  // пропорционально, кратно количеству
  const total = left
  lines.forEach((l, i) => {
    const share = Math.floor((total * l.unit * l.qty) / Math.max(1, gross))
    const unitOff = Math.min(l.unit, Math.floor(share / l.qty))
    perUnitOff[i] = unitOff
    left -= unitOff * l.qty
  })
  // добрать остаток целыми «копейками на единицу»
  for (let i = 0; i < lines.length && left > 0; i++) {
    const l = lines[i]
    const room = l.unit - perUnitOff[i]
    const add = Math.min(room, Math.floor(left / l.qty))
    perUnitOff[i] += add
    left -= add * l.qty
  }
  const out: Array<{ name: string; price: number; quantity: number; sum: number }> = []
  lines.forEach((l, i) => {
    const unit = l.unit - perUnitOff[i]
    if (left > 0 && l.qty > 1 && unit >= left) {
      // одна единица со своей ценой забирает неделимый остаток
      out.push({ name: l.name, price: unit / 100, quantity: l.qty - 1, sum: (unit * (l.qty - 1)) / 100 })
      out.push({ name: l.name, price: (unit - left) / 100, quantity: 1, sum: (unit - left) / 100 })
      left = 0
    } else if (left > 0 && l.qty === 1 && unit >= left) {
      out.push({ name: l.name, price: (unit - left) / 100, quantity: 1, sum: (unit - left) / 100 })
      left = 0
    } else {
      out.push({ name: l.name, price: unit / 100, quantity: l.qty, sum: (unit * l.qty) / 100 })
    }
  })
  return out
}

export function buildAtolReceipt(input: FiscalInput, env: Record<string, string | undefined> = process.env) {
  const c = clinic()
  const email = input.client.email && /^[^\s@]+@[^\s@]+$/.test(input.client.email) ? input.client.email : null
  const phone = e164ru(input.client.phone)
  if (!email && !phone) throw new Error('Для электронного чека нужен e-mail или телефон покупателя (АТОЛ: client.email или client.phone)')
  const vatType = env.ATOL_VAT || 'none'
  const lines = applyDiscount(input.items, input.discount)
  const total = Math.round(lines.reduce((s, l) => s + l.sum, 0) * 100) / 100
  return {
    timestamp: atolTimestamp(input.at ?? new Date()),
    external_id: input.externalId,
    receipt: {
      client: email ? { email } : { phone: phone! },
      company: {
        email: String(env.ATOL_COMPANY_EMAIL),
        sno: String(env.ATOL_SNO),
        inn: String(env.CLINIC_INN || c.inn),
        payment_address: String(env.ATOL_PAYMENT_ADDRESS),
      },
      items: lines.map((l) => ({
        name: l.name.slice(0, 128),
        price: l.price,
        quantity: l.quantity,
        measure: 0,
        sum: l.sum,
        payment_method: 'full_payment',
        payment_object: 4, // услуга
        vat: { type: vatType },
      })),
      payments: [{ type: input.method === 'CASH' ? 0 : 1, sum: total }],
      total,
      ...(input.cashier ? { cashier: input.cashier.slice(0, 64) } : {}),
    },
  }
}

// ---------- HTTP-клиент АТОЛ ----------

type Fetch = typeof fetch
let tokenCache: { token: string; at: number } | null = null

function base(env = process.env): string {
  return (env.ATOL_BASE_URL || 'https://online.atol.ru/possystem/v5').replace(/\/+$/, '')
}

async function getToken(f: Fetch, force = false): Promise<string> {
  if (!force && tokenCache && Date.now() - tokenCache.at < 23 * 3600_000) return tokenCache.token
  const res = await f(`${base()}/getToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ login: process.env.ATOL_LOGIN, pass: process.env.ATOL_PASSWORD }),
    signal: AbortSignal.timeout(15000),
  })
  const j = (await res.json().catch(() => ({}))) as { token?: string; error?: { code?: number; text?: string } | null }
  if (!j.token) throw new Error(`АТОЛ getToken: ${j.error?.text || `HTTP ${res.status}`}`)
  tokenCache = { token: j.token, at: Date.now() }
  return j.token
}

async function atolCall(f: Fetch, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(f, attempt > 0)
    const res = await f(`${base()}/${process.env.ATOL_GROUP_CODE}/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Token: token },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, any>
    // ExpiredToken: HTTP 401, code 11 — запросить новый токен и повторить один раз
    if (res.status === 401 && json?.error?.code === 11 && attempt === 0) continue
    return { status: res.status, json }
  }
  throw new Error('АТОЛ: не удалось обновить токен')
}

export interface FiscalSendResult {
  state: 'PENDING' | 'ERROR'
  uuid: string | null
  error: string | null
}

/** Отправка чека на регистрацию. Повторная отправка того же external_id безопасна (code 33). */
export async function sendReceipt(input: FiscalInput, f: Fetch = fetch): Promise<FiscalSendResult> {
  const st = fiscalStatus()
  if (!st.configured || st.provider !== 'atol') throw new FiscalNotConfiguredError(st.problem || 'Онлайн-касса не настроена')
  const doc = buildAtolReceipt(input)
  const { status, json } = await atolCall(f, 'POST', input.operation, doc)
  if (json.uuid && !json.error) return { state: 'PENDING', uuid: String(json.uuid), error: null }
  if (json.error?.code === 33) {
    // документ с этим external_id уже принят — результат берём по uuid, если он пришёл
    return json.uuid ? { state: 'PENDING', uuid: String(json.uuid), error: null } : { state: 'ERROR', uuid: null, error: 'АТОЛ: чек с этим external_id уже зарегистрирован — проверьте в личном кабинете' }
  }
  return { state: 'ERROR', uuid: null, error: `АТОЛ ${json.error?.code ?? status}: ${json.error?.text ?? 'ошибка регистрации чека'}` }
}

export interface FiscalReport {
  state: 'PENDING' | 'ISSUED' | 'ERROR'
  fiscalNumber: string | null
  receiptUrl: string | null
  error: string | null
}

/** Результат обработки чека по uuid (опрос, т.к. callback_url не используется). */
export async function fetchReport(uuid: string, f: Fetch = fetch): Promise<FiscalReport> {
  const { status, json } = await atolCall(f, 'GET', `report/${encodeURIComponent(uuid)}`)
  if (json.status === 'done' && json.payload) {
    const p = json.payload
    return {
      state: 'ISSUED',
      fiscalNumber: `ФН ${p.fn_number} · ФД ${p.fiscal_document_number} · ФП ${p.fiscal_document_attribute}`,
      receiptUrl: p.ofd_receipt_url ?? null,
      error: null,
    }
  }
  if (json.status === 'fail') return { state: 'ERROR', fiscalNumber: null, receiptUrl: null, error: `АТОЛ: ${json.error?.text ?? 'чек не зарегистрирован'}` }
  if (json.status === 'wait' || status === 200) return { state: 'PENDING', fiscalNumber: null, receiptUrl: null, error: null }
  return { state: 'ERROR', fiscalNumber: null, receiptUrl: null, error: `АТОЛ report HTTP ${status}` }
}

/** Только для тестов: сброс кеша токена. */
export function _resetTokenCache(): void {
  tokenCache = null
}
