// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Планировщик регулярных отчётов: ключевые операционные отчёты считаются
// по расписанию (DAILY/WEEKLY/MONTHLY), снимок CSV уходит письмом через
// email-провайдер (ИНТ-014), история запусков — ReportRun.
// Серверский модуль — не импортировать в клиентский код!

import { db } from '@/lib/db'
import { capacityOn } from '@/lib/appointment-rules'
import { dayKeysBetween, exceptionsBetween } from '@/lib/schedule-days'
import { escapeHtml, sendEmail } from './email'
import { allowedReportDomains, isAllowedReportEmail } from './report-access'
import { addDaysKey, dateKey, ddmm, pad2, parseDateKey, zonedParts, zonedTime } from './mis-utils'
import { SchedReportDef } from './types'

// Каталог отчётов, доступных планировщику (подмножество ОТЧ-01…36)
export const SCHED_REPORTS: SchedReportDef[] = [
  { key: 'ОТЧ-01', name: 'Загрузка врачей', note: 'План-факт занятости по врачам за период' },
  { key: 'ОТЧ-03', name: 'No-show и отмены', note: 'Неявки и отмены по врачам за период' },
  { key: 'ОТЧ-24', name: 'Движения ТМЦ', note: 'Приход/расход/перемещения по номенклатуре' },
  { key: 'ОТЧ-26', name: 'Выработка врачей', note: 'Визиты, выручка и средний чек по врачам' },
  { key: 'ОТЧ-27', name: 'Эффективность рассылок', note: 'Доставка и ответы Центра уведомлений' },
  { key: 'CASH_DAY', name: 'Касса за период', note: 'Оплаты по способам, возвраты, средний чек' },
]

export interface ReportResult {
  key: string
  title: string
  columns: Array<{ key: string; label: string }>
  rows: Array<Array<string | number>>
  csv: string
}

// CSV с BOM и «;» — открывается в Excel/1С как есть
function toCSV(columns: Array<{ key: string; label: string }>, rows: Array<Array<string | number>>): string {
  const esc = (v: string | number) => {
    const s = String(v)
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = columns.map((c) => esc(c.label)).join(';')
  const body = rows.map((r) => r.map(esc).join(';')).join('\n')
  return `\uFEFF${head}\n${body}`
}

// Выполнение отчёта по ключу за период (прямыми запросами к БД)
export async function runReportByKey(key: string, from: Date, to: Date): Promise<ReportResult> {
  const def = SCHED_REPORTS.find((r) => r.key === key)
  const title = def?.name ?? key

  if (key === 'ОТЧ-01') {
    const [doctors, appointments] = await Promise.all([
      db.doctor.findMany({ orderBy: { name: 'asc' } }),
      db.appointment.findMany({ where: { start: { gte: from, lte: to } } }),
    ])
    const keys = dayKeysBetween(from, to)
    const exs = await exceptionsBetween(keys[0], keys[keys.length - 1])
    const rows = doctors.map((d) => {
      const booked = appointments.filter((a) => a.doctorId === d.id && a.status !== 'CANCELED').length
      const cap = Math.max(1, capacityOn(d, keys, exs))
      return [d.name, d.specialty, booked, cap, `${Math.min(100, Math.round((booked / cap) * 100))}%`]
    })
    const columns = [
      { key: 'doctor', label: 'Врач' }, { key: 'specialty', label: 'Специальность' },
      { key: 'booked', label: 'Записей' }, { key: 'capacity', label: 'План слотов' }, { key: 'percent', label: 'Загрузка, %' },
    ]
    return { key, title, columns, rows, csv: toCSV(columns, rows) }
  }

  if (key === 'ОТЧ-03') {
    const [doctors, appointments] = await Promise.all([
      db.doctor.findMany({ orderBy: { name: 'asc' } }),
      db.appointment.findMany({ where: { start: { gte: from, lte: to } } }),
    ])
    const rows = doctors.map((d) => {
      const ds = appointments.filter((a) => a.doctorId === d.id)
      const ns = ds.filter((a) => a.status === 'NO_SHOW').length
      const cn = ds.filter((a) => a.status === 'CANCELED').length
      return [d.name, ds.length, ns, cn, ds.length ? `${Math.round((ns / ds.length) * 100)}%` : '0%']
    })
    const columns = [
      { key: 'doctor', label: 'Врач' }, { key: 'total', label: 'Приёмов' }, { key: 'noShow', label: 'Неявок' },
      { key: 'canceled', label: 'Отмен' }, { key: 'rate', label: 'No-show, %' },
    ]
    return { key, title, columns, rows, csv: toCSV(columns, rows) }
  }

  if (key === 'ОТЧ-24') {
    const [items, movements] = await Promise.all([
      db.stockItem.findMany({ orderBy: { name: 'asc' } }),
      db.stockMovement.findMany({ where: { createdAt: { gte: from, lte: to } } }),
    ])
    const rows = items.map((i) => {
      const ms = movements.filter((m) => m.itemId === i.id)
      const by = (t: string) => ms.filter((m) => m.type === t).reduce((s, m) => s + m.qty, 0)
      return [
        i.name, i.sku,
        by('IN') + by('TRANSFER_IN') + by('ADJ_IN'),
        by('OUT'), by('WRITEOFF'), by('TRANSFER_OUT') + by('TRANSFER_IN'),
        i.qty, i.qty * i.price,
      ]
    })
    const columns = [
      { key: 'item', label: 'Позиция' }, { key: 'sku', label: 'Артикул' }, { key: 'in', label: 'Приход' },
      { key: 'out', label: 'Расход' }, { key: 'writeoff', label: 'Списание' }, { key: 'transfer', label: 'Перемещения' },
      { key: 'qty', label: 'Остаток' }, { key: 'value', label: 'Стоимость, ₽' },
    ]
    return { key, title, columns, rows, csv: toCSV(columns, rows) }
  }

  if (key === 'ОТЧ-26') {
    const [doctors, visits] = await Promise.all([
      db.doctor.findMany({ orderBy: { name: 'asc' } }),
      db.visit.findMany({ where: { createdAt: { gte: from, lte: to } } }),
    ])
    const rows = doctors.map((d) => {
      const vs = visits.filter((v) => v.doctorId === d.id)
      const rev = vs.reduce((s, v) => s + (v.price || 0), 0)
      return [d.name, vs.length, rev, vs.length ? Math.round(rev / vs.length) : 0]
    })
    const columns = [
      { key: 'doctor', label: 'Врач' }, { key: 'visits', label: 'Визитов' },
      { key: 'revenue', label: 'Выручка, ₽' }, { key: 'avgCheck', label: 'Средний чек, ₽' },
    ]
    return { key, title, columns, rows, csv: toCSV(columns, rows) }
  }

  if (key === 'ОТЧ-27') {
    const notifications = await db.notification.findMany({ where: { createdAt: { gte: from, lte: to } } })
    const kinds = ['REMINDER', 'WAITLIST_OFFER', 'RISK_TOUCH', 'MANUAL', 'STOCK_LOW', 'EMAIL_FALLBACK']
    const rows = kinds.map((k) => {
      const rowsK = notifications.filter((n) => n.kind === k)
      const sent = rowsK.filter((n) => n.status === 'SENT').length
      const failed = rowsK.filter((n) => n.status === 'FAILED' || n.status === 'BLOCKED_BLACKLIST' || n.status === 'BLOCKED_LIMIT').length
      return [k, rowsK.length, sent, failed, rowsK.length ? `${Math.round((sent / rowsK.length) * 100)}%` : '0%']
    })
    const columns = [
      { key: 'kind', label: 'Тип' }, { key: 'total', label: 'Отправлено' }, { key: 'delivered', label: 'Доставлено' },
      { key: 'failed', label: 'Ошибок' }, { key: 'rate', label: 'Доставка, %' },
    ]
    return { key, title, columns, rows, csv: toCSV(columns, rows) }
  }

  if (key === 'CASH_DAY') {
    const payments = await db.payment.findMany({ where: { createdAt: { gte: from, lte: to } } })
    const METHODS: Record<string, string> = { CASH: 'Наличные', CARD: 'Карта', SBP: 'СБП' }
    const rows = Object.entries(METHODS).map(([m, label]) => {
      const ps = payments.filter((p) => p.method === m && p.type === 'PAYMENT' && p.status === 'PAID')
      const total = ps.reduce((s, p) => s + p.amount, 0)
      return [label, ps.length, total, ps.length ? Math.round(total / ps.length) : 0]
    })
    const refunds = payments.filter((p) => p.type === 'REFUND')
    rows.push(['Возвраты', refunds.length, -refunds.reduce((s, p) => s + Math.abs(p.amount), 0), 0])
    const columns = [
      { key: 'method', label: 'Способ' }, { key: 'count', label: 'Чеков' },
      { key: 'amount', label: 'Сумма, ₽' }, { key: 'avg', label: 'Средний чек, ₽' },
    ]
    return { key, title, columns, rows, csv: toCSV(columns, rows) }
  }

  throw new Error(`Неизвестный отчёт планировщика: ${key}`)
}

// ---------- Расписание ----------

// Следующий момент запуска для периодичности
export function computeNextRunAt(period: string, atTime: string, after: Date = new Date()): Date {
  // Время запуска atTime — в поясе клиники (CLINIC_TZ), а не сервера
  const [h, m] = atTime.split(':').map(Number)
  const base = new Date(Math.floor(after.getTime() / 60_000) * 60_000)
  const at = (key: string): Date => {
    const k = parseDateKey(key)!
    return zonedTime(k.y, k.m, k.d, h, m)
  }
  const todayK = dateKey(base)

  if (period === 'WEEKLY') {
    // ближайший понедельник в atTime
    const wd = zonedParts(base).weekday // 0 = Пн
    let shift = (7 - wd) % 7
    if (shift === 0 && at(todayK) <= base) shift = 7
    return at(addDaysKey(todayK, shift))
  }

  if (period === 'MONTHLY') {
    const z = zonedParts(base)
    const first = `${z.year}-${pad2(z.month)}-01`
    const candidate = at(first)
    if (candidate > base) return candidate
    const nm = z.month === 12 ? `${z.year + 1}-01-01` : `${z.year}-${pad2(z.month + 1)}-01`
    return at(nm)
  }

  // DAILY
  const today = at(todayK)
  if (today > base) return today
  return at(addDaysKey(todayK, 1))
}

// Окно периода для отчёта: от последнего запуска (или длины периода)
export function periodWindow(period: string, lastRunAt: Date | null): { from: Date; to: Date } {
  const to = new Date()
  const spanMs = period === 'MONTHLY' ? 30 : period === 'WEEKLY' ? 7 : 1
  const from = lastRunAt ?? new Date(to.getTime() - spanMs * 86400_000)
  return { from: from < to ? from : new Date(to.getTime() - 86400_000), to }
}

function renderHtmlTable(columns: Array<{ key: string; label: string }>, rows: Array<Array<string | number>>): string {
  const th = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')
  const tr = rows
    .map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`)
    .join('')
  return `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">
<thead><tr style="background:#ecfdf5">${th}</tr></thead><tbody>${tr}</tbody></table>`
}

// Выполнение одного расписания: отчёт → снимок CSV → письмо получателям
export async function executeSchedule(
  scheduleId: string,
  opts?: { manual?: boolean }
): Promise<{ runId: string; status: string; rowsCount: number; emailStatus: string | null }> {
  const schedule = await db.reportSchedule.findUnique({ where: { id: scheduleId } })
  if (!schedule) throw new Error('Расписание не найдено')

  const { from, to } = periodWindow(schedule.period, schedule.lastRunAt)
  const run = await db.reportRun.create({ data: { scheduleId, status: 'RUNNING' } })

  try {
    const report = await runReportByKey(schedule.reportKey, from, to)
    const days = ddmm(from) + '–' + ddmm(to)
    const summary = `${report.title}: ${report.rows.length} строк (${days}${opts?.manual ? ', вручную' : ''})`
    await db.reportRun.update({
      where: { id: run.id },
      data: { status: 'DONE', finishedAt: new Date(), rowsCount: report.rows.length, summary, csv: report.csv },
    })

    // Письмо с таблицей и вложением CSV (ИНТ-014)
    // повторная проверка домена при отправке: список мог измениться после создания расписания
    const domains = allowedReportDomains()
    const recipients = schedule.recipients.split(',').map((s) => s.trim()).filter((e) => e && isAllowedReportEmail(e, domains))
    let emailStatus: string | null = 'SKIPPED'
    let emailTo: string | null = null
    if (recipients.length > 0) {
      const subject = `«${schedule.name.replace(/[\r\n]+/g, ' ')}» — ${schedule.reportKey} (${days})`
      const html = `<p>Регулярный отчёт МИС MedFlow: <b>${escapeHtml(report.title)}</b> за период ${escapeHtml(days)}.</p>
${renderHtmlTable(report.columns, report.rows)}
<p style="color:#64748b;font-size:12px">Вложение: снимок CSV для 1С/Excel. Отправлено планировщиком${opts?.manual ? ' вручную' : ''}.</p>`
      let sentAny = false
      for (const to1 of recipients) {
        const res = await sendEmail({
          to: to1,
          subject,
          html,
          category: 'REPORT',
          attachment: {
            filename: `report-${schedule.reportKey}-${ddmm(to).replace('.', '')}.csv`,
            base64: Buffer.from(report.csv, 'utf8').toString('base64'),
          },
          meta: { scheduleId: schedule.id, reportKey: schedule.reportKey, runId: run.id },
        })
        if (res.ok) sentAny = true
      }
      emailStatus = sentAny ? 'SENT' : 'FAILED'
      emailTo = recipients.join(', ')
    }
    await db.reportRun.update({ where: { id: run.id }, data: { emailStatus, emailTo } })

    const nextRunAt = computeNextRunAt(schedule.period, schedule.atTime, new Date())
    await db.reportSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: new Date(), nextRunAt } })
    return { runId: run.id, status: 'DONE', rowsCount: report.rows.length, emailStatus }
  } catch (e) {
    const msg = (e as Error).message
    await db.reportRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), error: msg } })
    return { runId: run.id, status: 'FAILED', rowsCount: 0, emailStatus: null }
  }
}

// Тик планировщика: выполнить все активные расписания, чей момент настал.
// Вызывается мини-сервисом scheduler по расписанию (x-service-key).
export async function tickScheduler(): Promise<{ due: number; results: Array<{ scheduleId: string; name: string; status: string; rowsCount: number; emailStatus: string | null }> }> {
  const now = new Date()
  const due = await db.reportSchedule.findMany({ where: { active: true, nextRunAt: { lte: now } }, orderBy: { nextRunAt: 'asc' }, take: 10 })
  const results: Array<{ scheduleId: string; name: string; status: string; rowsCount: number; emailStatus: string | null }> = []
  for (const s of due) {
    const r = await executeSchedule(s.id)
    results.push({ scheduleId: s.id, name: s.name, status: r.status, rowsCount: r.rowsCount, emailStatus: r.emailStatus })
  }
  return { due: due.length, results }
}
