// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { computeNextRunAt, executeSchedule, SCHED_REPORTS } from '@/lib/reports-run'
import { ReportScheduleDTO } from '@/lib/types'
import { allowedReportDomains, canSeeSection, isAllowedReportEmail, SCHED_REPORT_SECTION } from '@/lib/report-access'

export const dynamic = 'force-dynamic'

// Планировщик регулярных отчётов: расписания (DAILY/WEEKLY/MONTHLY),
// история запусков, письмо с CSV — через email-провайдер (ИНТ-014).

function dto(s: { id: string; name: string; reportKey: string; period: string; atTime: string; recipients: string; active: boolean; lastRunAt: Date | null; nextRunAt: Date; createdBy: string | null; runs?: Array<{ id: string; status: string; startedAt: Date; finishedAt: Date | null; rowsCount: number; summary: string | null; emailStatus: string | null; emailTo: string | null; error: string | null }> }): ReportScheduleDTO {
  return {
    id: s.id,
    name: s.name,
    reportKey: s.reportKey,
    period: s.period,
    atTime: s.atTime,
    recipients: s.recipients,
    active: s.active,
    lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null,
    nextRunAt: s.nextRunAt.toISOString(),
    createdBy: s.createdBy,
    runs: (s.runs ?? []).map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      rowsCount: r.rowsCount,
      summary: r.summary,
      emailStatus: r.emailStatus,
      emailTo: r.emailTo,
      error: r.error,
    })),
  }
}

export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'reports.read')
  if (!g.ok) return g.res
  try {
    const schedules = await db.reportSchedule.findMany({
      orderBy: { createdAt: 'asc' },
      include: { runs: { orderBy: { startedAt: 'desc' }, take: 8 } },
    })
    return NextResponse.json({
      schedules: schedules.filter((x) => canSeeSection(g.user.role, SCHED_REPORT_SECTION[x.reportKey] ?? 'operations')).map(dto),
      catalog: SCHED_REPORTS.filter((r) => canSeeSection(g.user.role, SCHED_REPORT_SECTION[r.key] ?? 'operations')),
      allowedDomains: allowedReportDomains(),
    })
  } catch (e) {
    console.error('[reports/scheduler GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить планировщик отчётов' }, { status: 500 })
  }
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'reports.schedule')
  if (!g.ok) return g.res
  try {
    const body = await req.json()
    const action = body.action

    if (action === 'CREATE') {
      const name = String(body.name || '').trim()
      const reportKey = String(body.reportKey || '').trim()
      const period = ['DAILY', 'WEEKLY', 'MONTHLY'].includes(body.period) ? body.period : 'DAILY'
      const atTime = String(body.atTime || '').trim()
      const recipients = String(body.recipients || '').trim()
      if (name.length < 3) return NextResponse.json({ error: 'Название расписания — не короче 3 символов' }, { status: 400 })
      if (!SCHED_REPORTS.some((r) => r.key === reportKey)) return NextResponse.json({ error: 'Выберите отчёт из каталога' }, { status: 400 })
      if (!canSeeSection(g.user.role, SCHED_REPORT_SECTION[reportKey] ?? 'operations')) {
        return NextResponse.json({ error: 'Этот отчёт недоступен для вашей роли' }, { status: 403 })
      }
      if (!HHMM_RE.test(atTime)) return NextResponse.json({ error: 'Время запуска — в формате ЧЧ:ММ' }, { status: 400 })
      const list = recipients.split(',').map((s: string) => s.trim()).filter(Boolean)
      if (list.length === 0 || !list.every((e: string) => EMAIL_RE.test(e))) {
        return NextResponse.json({ error: 'Укажите email-получателей через запятую' }, { status: 400 })
      }
      const domains = allowedReportDomains()
      const foreign = list.filter((e: string) => !isAllowedReportEmail(e, domains))
      if (foreign.length > 0) {
        return NextResponse.json(
          { error: domains.length ? `Отчёты можно отправлять только на домены: ${domains.join(', ')}` : 'Рассылка отчётов не настроена: администратор не задал REPORT_EMAIL_DOMAINS' },
          { status: 400 }
        )
      }
      const nextRunAt = computeNextRunAt(period, atTime, new Date())
      const created = await db.reportSchedule.create({
        data: {
          name, reportKey, period, atTime,
          recipients: list.join(', '),
          active: true,
          nextRunAt,
          createdBy: g.user.name,
        },
      })
      await audit('reports.schedule_created', g.user.id, { id: created.id, name, reportKey, period, atTime })
      return NextResponse.json({ ok: true, schedule: dto(created) })
    }

    if (action === 'TOGGLE') {
      if (!body.id) return NextResponse.json({ error: 'Укажите id' }, { status: 400 })
      const s = await db.reportSchedule.findUnique({ where: { id: body.id } })
      if (!s) return NextResponse.json({ error: 'Расписание не найдено' }, { status: 404 })
      const updated = await db.reportSchedule.update({
        where: { id: body.id },
        data: { active: !s.active, nextRunAt: computeNextRunAt(s.period, s.atTime, new Date()) },
      })
      await audit('reports.schedule_toggled', g.user.id, { id: body.id, active: updated.active })
      return NextResponse.json({ ok: true, active: updated.active })
    }

    if (action === 'DELETE') {
      if (!body.id) return NextResponse.json({ error: 'Укажите id' }, { status: 400 })
      await db.reportSchedule.delete({ where: { id: body.id } })
      await audit('reports.schedule_deleted', g.user.id, { id: body.id })
      return NextResponse.json({ ok: true })
    }

    if (action === 'RUN_NOW') {
      if (!body.id) return NextResponse.json({ error: 'Укажите id' }, { status: 400 })
      const res = await executeSchedule(body.id, { manual: true })
      await audit('reports.schedule_run_manual', g.user.id, { id: body.id, status: res.status })
      if (res.status === 'FAILED') return NextResponse.json({ error: 'Запуск упал — см. историю' }, { status: 400 })
      return NextResponse.json({ ok: true, ...res })
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 })
  } catch (e) {
    if (e instanceof Error) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error('[reports/scheduler POST]', e)
    return NextResponse.json({ error: 'Не удалось выполнить действие' }, { status: 500 })
  }
}
