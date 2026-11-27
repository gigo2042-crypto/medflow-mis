// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Возврат оплаты (54-ФЗ): чистая логика без БД и без node-модулей — используется и API, и кассой (клиент).

/** Статус «чек в МИС не нужен»: возврат записью при внешней ККТ. Такие строки НИКОГДА не уходят в онлайн-кассу. */
export const FISCAL_NOT_REQUIRED = 'NOT_REQUIRED'

export type RefundPlan =
  | {
      ok: true
      /** true — возврат записью в журнале (провайдер не подключён, чек прихода пробит на внешней ККТ) */
      journal: boolean
      /** статус фискализации исходной оплаты, который фиксируется в updateMany (защита от гонки) */
      expectFiscalStatus: 'ISSUED' | 'QUEUED'
    }
  | { ok: false; code: 'NOT_FISCALIZED'; message: string }

const PENDING_MSG = 'Чек по оплате ещё в кассе — дождитесь результата, затем оформляйте возврат'
const NOT_ISSUED_MSG = 'Чек по оплате не пробит — возврат невозможен. Отмените оплату (действие «Отменить»), она не уйдёт в кассу'

/**
 * Можно ли оформить возврат и каким способом.
 *  • Онлайн-касса подключена или демо: только к пробитому (ISSUED) чеку прихода — чек возврата уходит в кассу.
 *  • Провайдер не подключён (production): чеки бьёт внешняя ККТ, оплаты в МИС остаются QUEUED —
 *    возврат по QUEUED оформляется записью (journal) без чека МИС. ISSUED (касса была подключена раньше) —
 *    обычный возврат, чек возврата ждёт подключения кассы. PENDING (чек отправлен в кассу, результат не получен)
 *    и ERROR (МИС пыталась пробить чек и не смогла) — возврат запрещён: ждать результата / отменить оплату.
 */
export function refundPlan(fiscalStatus: string, fiscalConfigured: boolean, demo: boolean): RefundPlan {
  if (fiscalStatus === 'ISSUED') return { ok: true, journal: false, expectFiscalStatus: 'ISSUED' }
  if (fiscalStatus === 'PENDING') return { ok: false, code: 'NOT_FISCALIZED', message: PENDING_MSG }
  if (!demo && !fiscalConfigured && fiscalStatus === 'QUEUED') return { ok: true, journal: true, expectFiscalStatus: 'QUEUED' }
  return { ok: false, code: 'NOT_FISCALIZED', message: NOT_ISSUED_MSG }
}

/** Текст уведомления кассира после возврата — честно: чек выдан, ждёт кассы или не нужен (внешняя ККТ). */
export function refundToast(amount: number, refundFiscalStatus: string | null | undefined, fiscalNote?: string | null): string {
  const sum = `${amount} ₽`
  if (refundFiscalStatus === 'ISSUED') return `Возврат ${sum} оформлен, чек возврата выдан`
  if (refundFiscalStatus === FISCAL_NOT_REQUIRED) return `Возврат ${sum} оформлен без чека — пробейте чек возврата на внешней ККТ`
  if (refundFiscalStatus === 'PENDING') return `Возврат ${sum} оформлен, чек возврата отправлен в онлайн-кассу`
  return `Возврат ${sum} оформлен, чек возврата не пробит${fiscalNote ? `: ${fiscalNote}` : ''}`
}
