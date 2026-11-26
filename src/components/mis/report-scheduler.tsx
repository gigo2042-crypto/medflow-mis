// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

// Планировщик регулярных отчётов (ТЗ гл. 9, ФТ-010): расписания выгрузок
// DAILY/WEEKLY/MONTHLY, письмо с CSV — через email-провайдер (ИНТ-014),
// история запусков и ручной прогон «Запустить сейчас».
// Управление — право reports.schedule (ADMIN/HEAD/MARKETER), просмотр — reports.read.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { can, Me } from '@/lib/rbac'
import { ddmmHHMM, pad2 } from '@/lib/mis-utils'
import {
  ReportRunDTO,
  ReportScheduleDTO,
  RUN_STATUS_LABELS,
  SCHEDULE_PERIOD_LABELS,
  SchedReportDef,
} from '@/lib/types'
import { toast } from 'sonner'
import {
  CalendarClock,
  CalendarPlus,
  History,
  Loader2,
  Lock,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Timer,
  Trash2,
} from 'lucide-react'

interface SchedulerData {
  schedules: ReportScheduleDTO[]
  catalog: SchedReportDef[]
}

interface FlatRun {
  schedule: ReportScheduleDTO
  run: ReportRunDTO
}

const PERIODS = ['DAILY', 'WEEKLY', 'MONTHLY']

const EMAIL_STATUS_LABELS: Record<string, string> = {
  SENT: 'Письмо отправлено',
  FAILED: 'Письмо не доставлено',
  SKIPPED: 'Получателей нет',
}

// Локальные форматтеры: даты «dd.mm hh:mm», бейджи статусов (палитра emerald/amber/rose/slate)
function fmt(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${ddmmHHMM(d)}`
}

function runBadgeClass(status: string): string {
  switch (status) {
    case 'DONE':
      return 'bg-emerald-100 text-emerald-700'
    case 'RUNNING':
      return 'bg-amber-100 text-amber-800'
    case 'FAILED':
      return 'bg-rose-100 text-rose-700'
    default:
      return 'bg-slate-100 text-slate-600'
  }
}

function emailBadgeClass(status: string | null): string {
  switch (status) {
    case 'SENT':
      return 'bg-emerald-100 text-emerald-700'
    case 'FAILED':
      return 'bg-rose-100 text-rose-700'
    case 'SKIPPED':
      return 'bg-slate-100 text-slate-400'
    default:
      return 'bg-slate-100 text-slate-400'
  }
}

function emailStatusShort(status: string | null): string {
  switch (status) {
    case 'SENT':
      return 'отправлено'
    case 'FAILED':
      return 'не доставлено'
    case 'SKIPPED':
      return 'не отправлялось (получателей нет)'
    default:
      return '—'
  }
}

function RunStatusBadge({ status }: { status: string }) {
  return <Badge className={`${runBadgeClass(status)} whitespace-nowrap`}>{RUN_STATUS_LABELS[status] ?? status}</Badge>
}

function EmailStatusBadge({ status }: { status: string | null }) {
  return (
    <Badge className={`${emailBadgeClass(status)} whitespace-nowrap`}>
      {EMAIL_STATUS_LABELS[status ?? ''] ?? 'Без письма'}
    </Badge>
  )
}

export default function ReportScheduler({ me }: { me: Me }) {
  const canManage = can(me, 'reports.schedule')
  const [data, setData] = useState<SchedulerData | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busyCreate, setBusyCreate] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [reportKey, setReportKey] = useState('')
  const [period, setPeriod] = useState('DAILY')
  const [atTime, setAtTime] = useState('')
  const [recipients, setRecipients] = useState('')

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true)
    try {
      setData(await api<SchedulerData>('/api/reports/scheduler'))
    } catch (e) {
      // фоновый опрос молчит — ошибку покажет ручное обновление
      if (!silent) toast.error((e as Error).message)
    } finally {
      if (!silent) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // автополлинг 15 с: запуски RUNNING «доживают» до DONE/FAILED на глазах
  useEffect(() => {
    const t = setInterval(() => {
      void load(true)
    }, 15_000)
    return () => clearInterval(t)
  }, [load])

  const stats = useMemo(() => {
    const list = data?.schedules ?? []
    const runs = list.flatMap((s) => s.runs)
    return {
      active: list.filter((s) => s.active).length,
      runs: runs.length,
      sent: runs.filter((r) => r.emailStatus === 'SENT').length,
    }
  }, [data])

  // плоская история: последние 10 запусков по всем расписаниям
  const flatRuns = useMemo<FlatRun[]>(() => {
    const list = data?.schedules ?? []
    return list
      .flatMap((s) => s.runs.map((run): FlatRun => ({ schedule: s, run })))
      .sort((a, b) => new Date(b.run.startedAt).getTime() - new Date(a.run.startedAt).getTime())
      .slice(0, 10)
  }, [data])

  const create = async () => {
    setBusyCreate(true)
    try {
      const res = await api<{ ok: boolean; schedule: ReportScheduleDTO }>('/api/reports/scheduler', {
        method: 'POST',
        body: JSON.stringify({
          action: 'CREATE',
          name: name.trim(),
          reportKey,
          period,
          atTime: atTime.trim(),
          recipients: recipients.trim(),
        }),
      })
      toast.success(`Расписание создано — первый запуск ${fmt(res.schedule.nextRunAt)}`)
      setName('')
      setReportKey('')
      setAtTime('')
      setRecipients('')
      await load(true)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusyCreate(false)
    }
  }

  const toggle = async (s: ReportScheduleDTO) => {
    try {
      const res = await api<{ ok: boolean; active: boolean }>('/api/reports/scheduler', {
        method: 'POST',
        body: JSON.stringify({ action: 'TOGGLE', id: s.id }),
      })
      toast.success(res.active ? `Расписание «${s.name}» включено` : `Расписание «${s.name}» на паузе`)
      await load(true)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const runNow = async (s: ReportScheduleDTO) => {
    setRunId(s.id)
    try {
      const res = await api<{ ok: boolean; runId: string; status: string; rowsCount: number; emailStatus: string | null }>(
        '/api/reports/scheduler',
        {
          method: 'POST',
          body: JSON.stringify({ action: 'RUN_NOW', id: s.id }),
        },
      )
      toast.success(`Отчёт сформирован: ${res.rowsCount} строк, письмо — ${emailStatusShort(res.emailStatus)}`)
      await load(true)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRunId(null)
    }
  }

  const remove = async (s: ReportScheduleDTO) => {
    try {
      await api<{ ok: boolean }>('/api/reports/scheduler', {
        method: 'POST',
        body: JSON.stringify({ action: 'DELETE', id: s.id }),
      })
      toast.success(`Расписание «${s.name}» удалено`)
      await load(true)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-slate-500">Загрузка планировщика…</CardContent>
      </Card>
    )
  }

  const schedules = data.schedules
  const catalog = data.catalog
  const reportName = (key: string) => catalog.find((c) => c.key === key)?.name ?? key
  const selectedNote = catalog.find((c) => c.key === reportKey)?.note ?? null

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarClock className="h-5 w-5 text-emerald-600" />
              Планировщик регулярных отчётов
            </CardTitle>
            <Button size="sm" variant="outline" onClick={() => void load()} disabled={refreshing} title="Обновить сейчас">
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          <p className="text-xs text-slate-500 pt-1">
            Регулярные выгрузки по расписанию, письмо с CSV — через email-провайдер (ИНТ-014), история запусков. Данные
            обновляются автоматически каждые 15 с.
          </p>
          <div className="flex flex-wrap gap-2 pt-2" aria-label="Статистика планировщика">
            <Badge className="bg-emerald-100 text-emerald-700">Активных расписаний: {stats.active}</Badge>
            <Badge className="bg-slate-100 text-slate-600">Запусков в истории: {stats.runs}</Badge>
            <Badge className="bg-amber-100 text-amber-800">Писем SENT: {stats.sent}</Badge>
          </div>
          {!canManage && (
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
              <Lock className="h-4 w-4 shrink-0 text-slate-400" />
              Управление расписаниями — роль руководителя/маркетолога/администратора
            </div>
          )}
        </CardHeader>
      </Card>

      {canManage && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <CalendarPlus className="h-4 w-4 text-emerald-600" />
              Новое расписание
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <label htmlFor="sched-name" className="text-xs font-medium text-slate-500">
                  Название
                </label>
                <Input
                  id="sched-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Название, напр. „Выручка дня для директора“"
                  className="h-9 text-sm"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="sched-report" className="text-xs font-medium text-slate-500">
                  Отчёт
                </label>
                <Select value={reportKey} onValueChange={setReportKey}>
                  <SelectTrigger id="sched-report" className="h-9 text-sm" aria-label="Отчёт для расписания">
                    <SelectValue placeholder="Выберите отчёт" />
                  </SelectTrigger>
                  <SelectContent>
                    {catalog.map((c) => (
                      <SelectItem key={c.key} value={c.key} className="text-sm">
                        {c.key} — {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedNote && <p className="text-[11px] leading-tight text-slate-400">{selectedNote}</p>}
              </div>

              <div className="space-y-1">
                <label htmlFor="sched-period" className="text-xs font-medium text-slate-500">
                  Периодичность
                </label>
                <Select value={period} onValueChange={setPeriod}>
                  <SelectTrigger id="sched-period" className="h-9 text-sm" aria-label="Периодичность запуска">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PERIODS.map((p) => (
                      <SelectItem key={p} value={p} className="text-sm">
                        {SCHEDULE_PERIOD_LABELS[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <label htmlFor="sched-time" className="text-xs font-medium text-slate-500">
                  Время запуска
                </label>
                <Input
                  id="sched-time"
                  value={atTime}
                  onChange={(e) => setAtTime(e.target.value)}
                  placeholder="09:00"
                  pattern="([01]\d|2[0-3]):[0-5]\d"
                  title="Формат ЧЧ:ММ (24 ч), например 09:00"
                  className="h-9 text-sm font-mono"
                />
                <p className="text-[11px] leading-tight text-slate-400">формат ЧЧ:ММ, например 09:00</p>
              </div>

              <div className="space-y-1 sm:col-span-2">
                <label htmlFor="sched-recipients" className="text-xs font-medium text-slate-500">
                  Получатели
                </label>
                <Input
                  id="sched-recipients"
                  value={recipients}
                  onChange={(e) => setRecipients(e.target.value)}
                  placeholder="email через запятую"
                  className="h-9 text-sm"
                />
              </div>

              <div className="flex items-end">
                <Button
                  onClick={() => void create()}
                  disabled={busyCreate || !name.trim() || !reportKey || !atTime.trim() || !recipients.trim()}
                  className="w-full bg-emerald-600 text-white hover:bg-emerald-700"
                  aria-label="Создать расписание"
                >
                  {busyCreate ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Создать расписание
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Timer className="h-4 w-4 text-slate-500" />
            Расписания
            <Badge variant="outline" className="text-[10px] text-slate-500">
              {schedules.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {schedules.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">
              {canManage ? 'Нет расписаний — создайте первое выше' : 'Нет расписаний'}
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table aria-label="Расписания регулярных отчётов">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Расписание</TableHead>
                    <TableHead className="text-xs">Отчёт</TableHead>
                    <TableHead className="text-xs">Период</TableHead>
                    <TableHead className="text-xs">Время</TableHead>
                    <TableHead className="text-xs">Получатели</TableHead>
                    <TableHead className="text-xs">Активность</TableHead>
                    <TableHead className="text-xs">Последний запуск</TableHead>
                    <TableHead className="text-xs">Следующий запуск</TableHead>
                    <TableHead className="text-xs">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedules.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <div className="text-sm font-medium">{s.name}</div>
                        {s.createdBy && <div className="text-[11px] text-slate-400">создал: {s.createdBy}</div>}
                      </TableCell>
                      <TableCell>
                        <div className="font-mono text-[11px] text-slate-500">{s.reportKey}</div>
                        <div className="text-xs text-slate-600">{reportName(s.reportKey)}</div>
                      </TableCell>
                      <TableCell className="text-xs">{SCHEDULE_PERIOD_LABELS[s.period] ?? s.period}</TableCell>
                      <TableCell className="font-mono text-xs">{s.atTime}</TableCell>
                      <TableCell>
                        <div className="max-w-[160px] truncate text-xs" title={s.recipients}>
                          {s.recipients}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          {s.active ? (
                            <Badge className="bg-emerald-100 text-emerald-700">Активно</Badge>
                          ) : (
                            <Badge className="bg-slate-100 text-slate-500">Пауза</Badge>
                          )}
                          {canManage && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 w-8 p-0"
                              onClick={() => void toggle(s)}
                              aria-label={s.active ? 'Поставить расписание на паузу' : 'Возобновить расписание'}
                              title={s.active ? 'Пауза' : 'Возобновить'}
                            >
                              {s.active ? (
                                <Pause className="h-4 w-4 text-slate-500" />
                              ) : (
                                <Play className="h-4 w-4 text-emerald-600" />
                              )}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const r = s.runs[0]
                          if (!r) return <span className="text-xs text-slate-400">ещё не запускалось</span>
                          return (
                            <div className="space-y-1">
                              <RunStatusBadge status={r.status} />
                              <div className="text-xs text-slate-500">{r.rowsCount} строк</div>
                              {r.summary && (
                                <div className="max-w-[180px] truncate text-[11px] text-slate-400" title={r.summary}>
                                  {r.summary}
                                </div>
                              )}
                            </div>
                          )
                        })()}
                      </TableCell>
                      <TableCell className="text-xs">{fmt(s.nextRunAt)}</TableCell>
                      <TableCell>
                        {canManage ? (
                          <div className="flex items-center gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
                              onClick={() => void runNow(s)}
                              disabled={runId === s.id}
                              aria-label={`Запустить «${s.name}» сейчас`}
                              title="Запустить сейчас"
                            >
                              {runId === s.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Play className="h-3.5 w-3.5" />
                              )}
                              <span className="hidden md:inline">Запустить сейчас</span>
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 w-8 p-0 text-slate-400 hover:text-rose-600"
                                  aria-label={`Удалить расписание «${s.name}»`}
                                  title="Удалить"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Удалить расписание и историю?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    «{s.name}» и история его запусков будут удалены безвозвратно.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Отмена</AlertDialogCancel>
                                  <AlertDialogAction
                                    className="bg-rose-600 text-white hover:bg-rose-700"
                                    onClick={() => void remove(s)}
                                  >
                                    Удалить
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <History className="h-4 w-4 text-slate-500" />
            История запусков
            <Badge variant="outline" className="text-[10px] text-slate-500">
              последние 10
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {flatRuns.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">
              Запусков пока не было — запустите отчёт вручную или дождитесь расписания
            </p>
          ) : (
            <div className="max-h-[360px] overflow-y-auto rounded-lg border">
              <Table aria-label="История запусков отчётов">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Расписание</TableHead>
                    <TableHead className="text-xs">Статус</TableHead>
                    <TableHead className="text-xs">Начат</TableHead>
                    <TableHead className="text-xs">Завершён</TableHead>
                    <TableHead className="text-xs">Строк</TableHead>
                    <TableHead className="text-xs">Письмо</TableHead>
                    <TableHead className="text-xs">Ошибка</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {flatRuns.map(({ schedule, run }) => (
                    <TableRow key={run.id}>
                      <TableCell>
                        <div className="max-w-[180px] truncate text-sm font-medium" title={schedule.name}>
                          {schedule.name}
                        </div>
                        <div className="font-mono text-[11px] text-slate-400">{schedule.reportKey}</div>
                      </TableCell>
                      <TableCell>
                        <RunStatusBadge status={run.status} />
                      </TableCell>
                      <TableCell className="text-xs">{fmt(run.startedAt)}</TableCell>
                      <TableCell className="text-xs">{run.finishedAt ? fmt(run.finishedAt) : '—'}</TableCell>
                      <TableCell className="text-xs">{run.rowsCount}</TableCell>
                      <TableCell>
                        <div className="space-y-0.5">
                          <EmailStatusBadge status={run.emailStatus} />
                          {run.emailTo && (
                            <div className="max-w-[140px] truncate text-[11px] text-slate-400" title={run.emailTo}>
                              {run.emailTo}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {run.error ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block max-w-[180px] truncate text-xs text-rose-600">{run.error}</span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[320px] whitespace-normal break-words text-left">
                              {run.error}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
