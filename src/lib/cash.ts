// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Касса (54-ФЗ): проверка сумм, лимит скидки, коды подтверждения. Серверный модуль.
import { randomInt } from 'crypto'

function intEnv(name: string, def: number, min: number, max: number): number {
  const v = Number(process.env[name])
  return Number.isInteger(v) && v >= min && v <= max ? v : def
}

/** Максимальная сумма одной оплаты, руб. (PAYMENT_MAX_RUB, по умолчанию 1 000 000) */
export function paymentMaxRub(): number {
  return intEnv('PAYMENT_MAX_RUB', 1_000_000, 1, 100_000_000)
}

/** Скидка без подтверждения администратора, % от суммы (DISCOUNT_MAX_PERCENT, по умолчанию 10) */
export function discountMaxPercent(): number {
  return intEnv('DISCOUNT_MAX_PERCENT', 10, 0, 100)
}

/** Срок действия кода подтверждения скидки, минут (DISCOUNT_APPROVAL_TTL_MIN, по умолчанию 30) */
export function discountApprovalTtlMin(): number {
  return intEnv('DISCOUNT_APPROVAL_TTL_MIN', 30, 1, 24 * 60)
}

/**
 * Сумма в рублях: только конечное целое число в [min, max]. Строки, NaN, Infinity, дроби — отказ.
 * Суммы хранятся в целых рублях (прайс клиники без копеек); переход на копейки — отдельная миграция.
 */
export function parseRub(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return null
  return v >= min && v <= max ? v : null
}

/** Предел скидки без подтверждения: процент от суммы, округление вниз */
export function discountLimit(total: number): number {
  return Math.floor((total * discountMaxPercent()) / 100)
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // без 0/O, 1/I
export function newApprovalCode(): string {
  let s = ''
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return s
}
export function normalizeApprovalCode(v: unknown): string {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16)
}

/** Ключ идемпотентности от клиента: 8–100 символов [A-Za-z0-9_-] */
export function parseClientKey(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return /^[A-Za-z0-9_-]{8,100}$/.test(s) ? s : null
}

export function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002'
}

/**
 * Нужен ли пробитый чек прихода для оформления возврата. В демо и при подключённой онлайн-кассе — да (54-ФЗ:
 * чек возврата выбивается только к пробитому чеку). Если фискальный провайдер не подключён, чеки выбивает
 * внешняя ККТ и статус в МИС не отслеживается (оплаты остаются QUEUED) — возврат оформляется записью в журнале.
 */
export function refundRequiresIssuedReceipt(fiscalConfigured: boolean, demo: boolean): boolean {
  return demo || fiscalConfigured
}

export { refundPlan, refundToast, FISCAL_NOT_REQUIRED } from '@/lib/refund-policy'
