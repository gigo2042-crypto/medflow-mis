// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Метрики в текстовом формате Prometheus (exposition format 0.0.4). Без ПДн: только счётчики.
import { db } from '@/lib/db'
import { logCounts } from '@/lib/log'
import { errorReportStats } from '@/lib/error-report'
import { timingSafeEqual } from 'node:crypto'
import { APP_VERSION } from '@/lib/version'

/** Доступ к /api/metrics: METRICS_TOKEN задан и совпал (Bearer или ?token нельзя — только заголовок). */
export function metricsAuthorized(header: string | null, env: Record<string, string | undefined> = process.env): 'ok' | 'disabled' | 'denied' {
  const token = env.METRICS_TOKEN
  if (!token) return 'disabled'
  const m = /^Bearer\s+(.+)$/i.exec(header || '')
  if (!m) return 'denied'
  const a = Buffer.from(m[1].trim())
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'denied'
}

type Sample = { name: string; help: string; type: 'gauge' | 'counter'; values: Array<{ labels?: Record<string, string>; value: number }> }

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')

export function renderPrometheus(samples: Sample[]): string {
  const out: string[] = []
  for (const s of samples) {
    out.push(`# HELP ${s.name} ${s.help}`, `# TYPE ${s.name} ${s.type}`)
    for (const v of s.values) {
      const l = v.labels && Object.keys(v.labels).length ? '{' + Object.entries(v.labels).map(([k, x]) => `${k}="${esc(x)}"`).join(',') + '}' : ''
      out.push(`${s.name}${l} ${Number.isFinite(v.value) ? v.value : 0}`)
    }
  }
  return out.join('\n') + '\n'
}

async function groupCount(q: () => Promise<Array<{ status: string; _count: { _all: number } }>>, known: string[]) {
  const rows = await q()
  const m = new Map(known.map((k) => [k, 0]))
  for (const r of rows) m.set(r.status, r._count._all)
  return [...m].map(([status, value]) => ({ labels: { status }, value }))
}

export async function collectMetrics(): Promise<string> {
  const mem = process.memoryUsage()
  const samples: Sample[] = [
    { name: 'medflow_up', help: 'Приложение отвечает', type: 'gauge', values: [{ value: 1 }] },
    { name: 'medflow_build_info', help: 'Режим сборки', type: 'gauge', values: [{ labels: { mode: process.env.APP_MODE === 'demo' ? 'demo' : 'production', version: APP_VERSION }, value: 1 }] },
    { name: 'medflow_process_uptime_seconds', help: 'Время работы процесса', type: 'gauge', values: [{ value: Math.round(process.uptime()) }] },
    { name: 'medflow_process_resident_memory_bytes', help: 'RSS процесса', type: 'gauge', values: [{ value: mem.rss }] },
    { name: 'medflow_process_heap_used_bytes', help: 'Использовано кучи V8', type: 'gauge', values: [{ value: mem.heapUsed }] },
    { name: 'medflow_log_messages_total', help: 'Сообщений в журнале процесса по уровням', type: 'counter', values: [{ labels: { level: 'error' }, value: logCounts().error }, { labels: { level: 'warn' }, value: logCounts().warn }] },
    { name: 'medflow_error_reports_total', help: 'Отчёты об ошибках (SENTRY_DSN): отправлено/отброшено', type: 'counter', values: [{ labels: { result: 'sent' }, value: errorReportStats().sent }, { labels: { result: 'dropped' }, value: errorReportStats().dropped }] },
  ]
  const t0 = performance.now()
  let dbUp = 0
  try {
    await db.$queryRaw`SELECT 1`
    dbUp = 1
  } catch {
    /* БД недоступна — остальные метрики из БД не собираем */
  }
  samples.push(
    { name: 'medflow_db_up', help: 'БД доступна', type: 'gauge', values: [{ value: dbUp }] },
    { name: 'medflow_db_ping_seconds', help: 'Время SELECT 1', type: 'gauge', values: [{ value: Math.round(performance.now() - t0) / 1000 }] },
  )
  if (dbUp) {
    const now = new Date()
    const [fiscal, integr, reminders, sessions, drafts] = await Promise.all([
      groupCount(async () => (await db.payment.groupBy({ by: ['fiscalStatus'], _count: { _all: true }, where: { fiscalStatus: { in: ['QUEUED', 'PENDING', 'ERROR'] } } })).map((r) => ({ status: r.fiscalStatus ?? '', _count: r._count })), ['QUEUED', 'PENDING', 'ERROR']),
      groupCount(() => db.integrationEvent.groupBy({ by: ['status'], _count: { _all: true }, where: { status: { in: ['QUEUED', 'ERROR', 'DLQ'] } } }) as never, ['QUEUED', 'ERROR', 'DLQ']),
      groupCount(() => db.reminder.groupBy({ by: ['status'], _count: { _all: true }, where: { status: { in: ['PLANNED', 'FAILED'] } } }) as never, ['PLANNED', 'FAILED']),
      db.authSession.count({ where: { expiresAt: { gt: now } } }),
      db.widgetDraft.count({ where: { status: 'PENDING' } }),
    ])
    samples.push(
      { name: 'medflow_fiscal_payments', help: 'Платежи в очереди/с ошибкой фискализации (54-ФЗ)', type: 'gauge', values: fiscal },
      { name: 'medflow_integration_events', help: 'События интеграций в очереди/с ошибкой/в DLQ', type: 'gauge', values: integr },
      { name: 'medflow_reminders', help: 'Напоминания пациентам: запланировано/не доставлено', type: 'gauge', values: reminders },
      { name: 'medflow_sessions_active', help: 'Активные сессии сотрудников', type: 'gauge', values: [{ value: sessions }] },
      { name: 'medflow_widget_drafts_pending', help: 'Неподтверждённые записи из виджета', type: 'gauge', values: [{ value: drafts }] },
    )
  }
  return renderPrometheus(samples)
}
