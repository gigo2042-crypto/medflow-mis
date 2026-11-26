// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { Me, can } from '@/lib/rbac'
import {
  CallEventDTO, DmsClaimDTO, EgiszDocDTO, EGISZ_STATUS_LABELS, IntegrationCardDTO, IntegrationEventDTO,
  LabReferralDTO, LAB_STATUS_LABELS, DMS_STATUS_LABELS, CALL_STATUS_LABELS, PolicyDTO,
  OneCExportDTO, ONEC_SCOPE_LABELS, ONEC_STATUS_LABELS,
} from '@/lib/types'
import { ddmm, ddmmHHMM, pad2 } from '@/lib/mis-utils'
import { toast } from 'sonner'
import {
  RefreshCw, Workflow, Plug, ShieldAlert, Activity, FileCheck2, FlaskConical, HeartHandshake,
  PhoneCall, PhoneOff, PhoneIncoming, CheckCircle2, Boxes, Mail, KeyRound, FileCode2, Download, Loader2,
} from 'lucide-react'

interface IntegrationsData {
  catalog: IntegrationCardDTO[]
  retrySchedule: number[]
  egisz: EgiszDocDTO[]
  labs: LabReferralDTO[]
  claims: DmsClaimDTO[]
  calls: CallEventDTO[]
  events: IntegrationEventDTO[]
  policies: PolicyDTO[]
  stats: {
    egiszQueued: number
    egiszConfirmed: number
    egiszError: number
    labsPending: number
    labsImported: number
    dmsCreated: number
    dmsPaid: number
    dmsDenied: number
    dmsRevenue: number
    missedCalls: number
    activeTasks: number
    dlq: number
  }
}

// Выгрузки в 1С (ИНТ-006): пакеты CommerceML-XML и статистика обмена
interface OneCData {
  exports: OneCExportDTO[]
  stats: {
    total: number
    queued: number
    sent: number
    confirmed: number
    error: number
    totalDocs: number
    totalSize: number
  }
}

type OneCScope = 'NOMENCLATURE' | 'BALANCES' | 'DOCS'

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return `${ddmmHHMM(d)}`
}

function fmtMoney(n: number): string {
  return `${n.toLocaleString('ru-RU')} ₽`
}

function fmtDay(iso: string): string {
  const d = new Date(iso)
  return `${ddmm(d)}`
}

function fmtKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} КБ`
}

function healthClass(h: string): string {
  if (h === 'CONFIGURED') return 'bg-emerald-100 text-emerald-700'
  if (h === 'SIMULATOR') return 'bg-violet-100 text-violet-700'
  if (h === 'MANUAL') return 'bg-amber-100 text-amber-800'
  return 'bg-slate-100 text-slate-500'
}

function healthLabel(h: string): string {
  if (h === 'CONFIGURED') return 'настроено'
  if (h === 'SIMULATOR') return 'симулятор'
  if (h === 'MANUAL') return 'вручную'
  return 'не подключено'
}

function egiszClass(s: string): string {
  switch (s) {
    case 'CONFIRMED': return 'bg-emerald-100 text-emerald-700'
    case 'SENT': return 'bg-teal-100 text-teal-700'
    case 'QUEUED': return 'bg-slate-100 text-slate-600'
    default: return 'bg-rose-100 text-rose-700'
  }
}

function labClass(s: string): string {
  switch (s) {
    case 'IMPORTED': return 'bg-emerald-100 text-emerald-700'
    case 'RESULT_READY': return 'bg-teal-100 text-teal-700'
    case 'SENT': return 'bg-slate-100 text-slate-600'
    case 'CREATED': return 'bg-slate-100 text-slate-500'
    default: return 'bg-rose-100 text-rose-700'
  }
}

function dmsClass(s: string): string {
  switch (s) {
    case 'PAID': return 'bg-emerald-100 text-emerald-700'
    case 'SUBMITTED': return 'bg-teal-100 text-teal-700'
    case 'CREATED': return 'bg-slate-100 text-slate-600'
    default: return 'bg-rose-100 text-rose-700'
  }
}

function callClass(s: string): string {
  switch (s) {
    case 'ANSWERED': return 'bg-emerald-100 text-emerald-700'
    case 'INCOMING': return 'bg-amber-100 text-amber-800'
    case 'MISSED': return 'bg-rose-100 text-rose-700'
    default: return 'bg-violet-100 text-violet-700'
  }
}

function onecClass(s: string): string {
  switch (s) {
    case 'QUEUED': return 'bg-amber-100 text-amber-800'
    case 'SENT': return 'bg-slate-100 text-slate-600'
    case 'CONFIRMED': return 'bg-emerald-100 text-emerald-700'
    default: return 'bg-rose-100 text-rose-700'
  }
}

// Интеграции (ИНТ-001..018): ЕГИСЗ/СМЭВ, лаборатории с backoff и DLQ,
// ДМС-реестры, телефония CTI (карточка звонка, пропущенные — задачи).
export default function Integrations({ me }: { me: Me }) {
  const canManage = can(me, 'integrations.manage')
  const canViewOneC = can(me, 'integrations.read')
  const [data, setData] = useState<IntegrationsData | null>(null)
  const [busy, setBusy] = useState(false)
  const [callPhone, setCallPhone] = useState('+7 900 555-01-01')
  const [onec, setOnec] = useState<OneCData | null>(null)
  const [onecBusy, setOnecBusy] = useState(false)
  const [onecScope, setOneCScope] = useState<OneCScope>('NOMENCLATURE')
  const [onecDays, setOneCDays] = useState('7')
  const [xmlView, setXmlView] = useState<{ title: string; xml: string } | null>(null)
  const [xmlBusy, setXmlBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api<IntegrationsData>('/api/integrations')
      setData(d)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
    const poll = setInterval(load, 15000)
    return () => clearInterval(poll)
  }, [load])

  const loadOneC = useCallback(async () => {
    if (!canViewOneC) return
    try {
      const d = await api<OneCData>('/api/integrations/1c')
      setOnec(d)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [canViewOneC])

  useEffect(() => {
    loadOneC()
    const poll = setInterval(loadOneC, 15000)
    return () => clearInterval(poll)
  }, [loadOneC])

  const createOneCExport = async () => {
    setOnecBusy(true)
    try {
      const days = Number(onecDays) || 7
      const res = await api<{ export: OneCExportDTO }>('/api/integrations/1c', {
        method: 'POST',
        body: JSON.stringify({ action: 'CREATE', scope: onecScope, from: Date.now() - days * 86400000, to: Date.now() }),
      })
      toast.success(`Пакет в очереди: ${res.export.docsCount} документов`)
      loadOneC()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setOnecBusy(false)
    }
  }

  const processOneC = async () => {
    setOnecBusy(true)
    try {
      const res = await api<{ result: { sent: number; confirmed: number; retried: number; failed: number } }>(
        '/api/integrations/1c',
        { method: 'POST', body: JSON.stringify({ action: 'PROCESS' }) },
      )
      const r = res.result
      toast.success(`Обмен с 1С: отправлено ${r.sent}, подтверждено ${r.confirmed}, повтор ${r.retried}`)
      loadOneC()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setOnecBusy(false)
    }
  }

  const showOneCXml = async (ex: OneCExportDTO) => {
    const title = `${ex.scopeLabel}, ${fmtDay(ex.periodFrom)}–${fmtDay(ex.periodTo)} · №${ex.id.slice(-6).toUpperCase()}`
    setXmlView({ title, xml: '' })
    setXmlBusy(true)
    try {
      const res = await api<{ xml: string }>(`/api/integrations/1c/${ex.id}`)
      setXmlView({ title, xml: res.xml })
    } catch (e) {
      toast.error((e as Error).message)
      setXmlView(null)
    } finally {
      setXmlBusy(false)
    }
  }

  const process = async () => {
    setBusy(true)
    try {
      const res = await api<{
        worker: {
          emdSent: number; emdConfirmed: number; emdRetried: number; emdDlq: number
          labsSent: number; labsResults: number; labsImported: number; labsRetried: number; labsDlq: number
          dmsSubmitted: number; dmsResolved: number
        }
      }>('/api/integrations', { method: 'POST', body: JSON.stringify({ action: 'PROCESS' }) })
      const w = res.worker
      const parts: string[] = []
      if (w.emdSent) parts.push(`ЭМД отправлено: ${w.emdSent}`)
      if (w.emdConfirmed) parts.push(`подтверждено СМЭВ: ${w.emdConfirmed}`)
      if (w.emdRetried) parts.push(`ЭМД на повторе: ${w.emdRetried}`)
      if (w.labsSent) parts.push(`направления переданы: ${w.labsSent}`)
      if (w.labsResults) parts.push(`результаты готовы: ${w.labsResults}`)
      if (w.labsImported) parts.push(`импортировано в ЭМК: ${w.labsImported}`)
      if (w.labsRetried) parts.push(`лабы на повторе: ${w.labsRetried}`)
      if (w.dmsSubmitted) parts.push(`ДМС-реестр отправлен: ${w.dmsSubmitted}`)
      if (w.dmsResolved) parts.push(`ДМС-ответы: ${w.dmsResolved}`)
      toast.success(parts.length ? `Воркер: ${parts.join(', ')}` : 'Очереди пусты — нечего обрабатывать')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const simulateCall = async () => {
    setBusy(true)
    try {
      const res = await api<{
        call: {
          callId: string
          patientId: string | null
          patientName: string | null
          patientCard: string | null
          lastVisitAt: string | null
          appointmentsCount: number
        } | null
      }>('/api/integrations', { method: 'POST', body: JSON.stringify({ action: 'CALL_IN', phone: callPhone }) })
      const c = res.call
      if (c?.patientName) {
        toast.success(`CTI: входящий ${callPhone} — ${c.patientName} (карта ${c.patientCard}, приёмов: ${c.appointmentsCount})`)
      } else {
        toast.info('CTI: входящий с неизвестного номера — заведите пациента и записывайте')
      }
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const setCallStatus = async (id: string, status: 'ANSWERED' | 'MISSED' | 'TASK') => {
    try {
      await api('/api/integrations', { method: 'POST', body: JSON.stringify({ action: 'CALL_STATUS', id, status }) })
      if (status === 'ANSWERED') toast.success('Звонок принят — разговор записан (ИНТ-003)')
      if (status === 'MISSED') toast.info('Пропущен — стал задачей регистратуры: перезвонить (ФТ-011)')
      if (status === 'TASK') toast.info('Задача на перезвон создана')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-slate-500">Загрузка интеграций…</CardContent>
      </Card>
    )
  }

  const s = data.stats
  const incoming = data.calls.find((c) => c.status === 'INCOMING')
  const missed = data.calls.filter((c) => c.status === 'MISSED' || c.status === 'TASK')

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="flex items-center gap-2 text-base">
              <Plug className="h-5 w-5 text-emerald-600" />
              Интеграции
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="outline" onClick={load} title="Обновить">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              {canManage && (
                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={process} disabled={busy}>
                  <Workflow className="h-3.5 w-3.5 mr-1" />
                  {busy ? 'Обработка...' : 'Обработать очереди'}
                </Button>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Badge className="bg-slate-100 text-slate-600">ЭМД в очереди: {s.egiszQueued}</Badge>
            <Badge className="bg-emerald-100 text-emerald-700">подтверждено СМЭВ: {s.egiszConfirmed}</Badge>
            <Badge className="bg-teal-100 text-teal-700">лабы в работе: {s.labsPending}</Badge>
            <Badge className="bg-teal-100 text-teal-700">результатов в ЭМК: {s.labsImported}</Badge>
            <Badge className="bg-emerald-100 text-emerald-700">ДМС оплачено: {fmtMoney(s.dmsRevenue)}</Badge>
            <Badge className={s.missedCalls > 0 ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500'}>
              пропущенных звонков: {s.missedCalls}
            </Badge>
            {s.dlq > 0 && <Badge className="bg-amber-100 text-amber-800">DLQ: {s.dlq}</Badge>}
          </div>
          <p className="text-xs text-slate-500 pt-1">
            Обмен через transactional outbox (АРХ-004): повторы {data.retrySchedule.join(' → ')} мин, затем DLQ и ручная
            обработка (ИНТ-001). Завершённые визиты автоматически ставят ЭМД в очередь ЕГИСЗ (ИНТ-010).
          </p>
        </CardHeader>
        {!canManage && (
          <CardContent className="pt-0">
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
              Ваша роль видит состояние интеграций (integrations.read); воркеры и телефония — у регистратуры и
              администратора (integrations.manage).
            </div>
          </CardContent>
        )}
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {data.catalog.map((c) => (
          <Card key={c.key}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-sm leading-snug">{c.name}</CardTitle>
                <Badge className={`text-[10px] shrink-0 ${healthClass(c.health)}`}>{healthLabel(c.health)}</Badge>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                <Badge variant="outline" className="text-[10px] font-mono">{c.requirement}</Badge>
                <Badge variant="outline" className="text-[10px] text-slate-500">{c.protocol}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-slate-600">{c.note}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {canViewOneC && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <CardTitle className="flex items-center gap-2 text-base">
                <Boxes className="h-5 w-5 text-emerald-600" />
                Выгрузки в 1С — складской контур (ИНТ-006)
              </CardTitle>
              {canManage && (
                <Button size="sm" variant="outline" onClick={processOneC} disabled={onecBusy} title="Прогнать очередь обмена с 1С">
                  <Workflow className="h-3.5 w-3.5 mr-1" />
                  {onecBusy ? 'Обмен...' : 'Обработать очередь'}
                </Button>
              )}
            </div>
            {onec && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Badge className="bg-slate-100 text-slate-600">пакетов: {onec.stats.total}</Badge>
                <Badge className="bg-amber-100 text-amber-800">в очереди: {onec.stats.queued}</Badge>
                <Badge className="bg-emerald-100 text-emerald-700">подтверждено 1С: {onec.stats.confirmed}</Badge>
                <Badge className={onec.stats.error > 0 ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500'}>
                  ошибок: {onec.stats.error}
                </Badge>
                <Badge variant="outline" className="text-[10px] text-slate-600">документов: {onec.stats.totalDocs}</Badge>
                <Badge variant="outline" className="text-[10px] text-slate-600">объём: {fmtKb(onec.stats.totalSize)}</Badge>
              </div>
            )}
            <p className="text-xs text-slate-500 pt-1">
              Пакеты CommerceML-XML — номенклатура, остатки по складам, документы движений за период.
              Очередь с 3 попытками; тик раз в 15 минут и по событию, вручную — кнопкой выше.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {canManage && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <div className="text-xs text-slate-500">Область выгрузки</div>
                  <Select value={onecScope} onValueChange={(v) => setOneCScope(v as OneCScope)}>
                    <SelectTrigger className="w-56 h-9 text-sm" aria-label="Область выгрузки в 1С">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(ONEC_SCOPE_LABELS).map(([k, v]) => (
                        <SelectItem key={k} value={k}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-slate-500">Период</div>
                  <Select value={onecDays} onValueChange={setOneCDays}>
                    <SelectTrigger className="w-36 h-9 text-sm" aria-label="Период выгрузки в 1С">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="7">за 7 дней</SelectItem>
                      <SelectItem value="30">за 30 дней</SelectItem>
                      <SelectItem value="90">за 90 дней</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={createOneCExport} disabled={onecBusy}>
                  {onecBusy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileCode2 className="h-3.5 w-3.5 mr-1" />}
                  {onecBusy ? 'Формирование...' : 'Сформировать пакет XML'}
                </Button>
              </div>
            )}
            <div className="rounded-lg border max-h-[380px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">№</TableHead>
                    <TableHead className="w-28">Создан</TableHead>
                    <TableHead>Область</TableHead>
                    <TableHead className="w-28">Период</TableHead>
                    <TableHead className="w-44">Статус 1С</TableHead>
                    <TableHead className="w-24">Документов</TableHead>
                    <TableHead className="w-24">Размер</TableHead>
                    <TableHead className="w-20">Попытки</TableHead>
                    <TableHead className="w-44">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {onec === null && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-sm text-slate-500 py-6">
                        Загрузка выгрузок 1С…
                      </TableCell>
                    </TableRow>
                  )}
                  {onec !== null && onec.exports.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-sm text-slate-500 py-6">
                        Пакетов пока нет{canManage ? ' — сформируйте первый выше' : ''}
                      </TableCell>
                    </TableRow>
                  )}
                  {onec?.exports.map((ex, i) => (
                    <TableRow key={ex.id}>
                      <TableCell className="text-xs font-mono text-slate-400">{i + 1}</TableCell>
                      <TableCell className="text-xs font-mono text-slate-500">{fmtWhen(ex.createdAt)}</TableCell>
                      <TableCell className="text-xs font-medium">{ex.scopeLabel}</TableCell>
                      <TableCell className="text-xs font-mono text-slate-600">
                        {fmtDay(ex.periodFrom)}–{fmtDay(ex.periodTo)}
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${onecClass(ex.status)}`} title={ex.error ?? undefined}>
                          {ONEC_STATUS_LABELS[ex.status] ?? ex.status}
                        </Badge>
                        {ex.error && (
                          <div className="text-[10px] text-rose-500 mt-0.5 max-w-44 truncate" title={ex.error}>
                            {ex.error}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs font-mono">{ex.docsCount}</TableCell>
                      <TableCell className="text-xs font-mono text-slate-600">{fmtKb(ex.size)}</TableCell>
                      <TableCell className="text-xs text-slate-600">{ex.attempts}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() => showOneCXml(ex)}
                            aria-label={`Показать XML пакета №${i + 1}`}
                          >
                            <FileCode2 className="h-3 w-3 mr-1" /> XML
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" asChild>
                            <a
                              href={`/api/integrations/1c/${ex.id}?download=1`}
                              download
                              aria-label={`Скачать XML пакета №${i + 1}`}
                            >
                              <Download className="h-3 w-3 mr-1" /> Скачать
                            </a>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Mail className="h-4 w-4 text-slate-500" />
              Email-провайдер (ИНТ-014)
            </CardTitle>
            <div className="flex gap-1.5 flex-wrap">
              <Badge variant="outline" className="text-[10px] font-mono">ИНТ-014</Badge>
              <Badge variant="outline" className="text-[10px] text-slate-500">REST провайдера, резервный SMTP</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-slate-600">
              Транзакционные письма — уведомления, отчёты, приглашения. REST-провайдер и резервный SMTP;
              3 попытки доставки, финальный сбой — в Центр уведомлений (ФТ-013).
            </p>
            <div className="flex flex-col items-start gap-1">
              <Button size="sm" variant="outline" className="border-emerald-300 text-emerald-700 hover:bg-emerald-50" asChild>
                <a href="/?XTransformPort=3040" target="_blank" rel="noreferrer">Открыть консоль провайдера</a>
              </Button>
              <span className="text-[10px] text-slate-400">мини-сервис :3040</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-slate-500" />
              ССО корпоративных клиентов (ИНТ-013)
            </CardTitle>
            <div className="flex gap-1.5 flex-wrap">
              <Badge variant="outline" className="text-[10px] font-mono">ИНТ-013</Badge>
              <Badge variant="outline" className="text-[10px] text-slate-500">OIDC authorization code</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-slate-600">
              Единый вход сотрудников по OIDC (authorization code); резервный локальный вход с 2FA.
              Сопоставление учётных записей по ssoSubject в МИС.
            </p>
            <div className="flex flex-col items-start gap-1">
              <Button size="sm" variant="outline" asChild>
                <a href="/?XTransformPort=3041" target="_blank" rel="noreferrer">Страница демо-IdP ClinicCorp ID</a>
              </Button>
              <span className="text-[10px] text-slate-400">мини-сервис :3041, демо-пароль sso1234</span>
            </div>
            <p className="text-[10px] text-slate-500">Вход через SSO — на экране входа МИС.</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="egisz">
        <TabsList className="mb-3 flex-wrap h-auto">
          <TabsTrigger value="egisz">ЕГИСЗ · СМЭВ</TabsTrigger>
          <TabsTrigger value="labs">Лаборатории</TabsTrigger>
          <TabsTrigger value="dms">ДМС-реестры</TabsTrigger>
          <TabsTrigger value="cti">Телефония CTI</TabsTrigger>
          <TabsTrigger value="outbox">Outbox-журнал</TabsTrigger>
        </TabsList>

        <TabsContent value="egisz">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileCheck2 className="h-4 w-4 text-slate-500" />
                Очередь ЭМД (ИНТ-010): передача медицинских документов по визитам
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border max-h-[380px] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Пациент</TableHead>
                      <TableHead>Врач · визит</TableHead>
                      <TableHead className="w-44">Статус СМЭВ</TableHead>
                      <TableHead className="w-40">Идентификатор</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.egisz.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-sm text-slate-500 py-6">
                          ЭМД нет — завершите приём в контуре ЭМК: визит автоматически встанет в очередь
                        </TableCell>
                      </TableRow>
                    )}
                    {data.egisz.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell>
                          <div className="text-sm font-medium">{d.patientName}</div>
                          <div className="text-[10px] text-slate-400 font-mono">{d.cardNumber}</div>
                        </TableCell>
                        <TableCell>
                          <div className="text-xs">{d.doctorName}</div>
                          <div className="text-[10px] text-slate-400 font-mono">{d.visitId.slice(-6).toUpperCase()}</div>
                        </TableCell>
                        <TableCell>
                          <Badge className={`text-[10px] ${egiszClass(d.status)}`}>{EGISZ_STATUS_LABELS[d.status] ?? d.status}</Badge>
                          {d.error && <div className="text-[10px] text-rose-500 mt-0.5">{d.error}</div>}
                        </TableCell>
                        <TableCell className="text-[10px] font-mono text-slate-500">
                          {d.smevId ?? '—'}
                          {d.confirmedAt && <div className="text-emerald-600">подтв. {fmtWhen(d.confirmedAt)}</div>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="labs">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <FlaskConical className="h-4 w-4 text-slate-500" />
                Лабораторные направления (ИНТ-001): отправка, статусы, импорт в ЭМК
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border max-h-[380px] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Пациент</TableHead>
                      <TableHead>Лаборатория · исследования</TableHead>
                      <TableHead className="w-44">Статус</TableHead>
                      <TableHead>Результат</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.labs.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-sm text-slate-500 py-6">
                          Направлений нет
                        </TableCell>
                      </TableRow>
                    )}
                    {data.labs.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="text-sm">{r.patientName}</TableCell>
                        <TableCell>
                          <div className="text-xs font-medium">{r.lab}</div>
                          <div className="text-[10px] text-slate-500">{r.tests.map((t) => t.name).join(', ')}</div>
                        </TableCell>
                        <TableCell>
                          <Badge className={`text-[10px] ${labClass(r.status)}`}>{LAB_STATUS_LABELS[r.status] ?? r.status}</Badge>
                          {r.error && <div className="text-[10px] text-rose-500 mt-0.5">{r.error}</div>}
                          {r.importedAt && <div className="text-[10px] text-emerald-600 mt-0.5">в ЭМК {fmtWhen(r.importedAt)}</div>}
                        </TableCell>
                        <TableCell className="text-xs text-slate-600 max-w-80" title={r.resultText ?? ''}>
                          {r.resultText ? <span className="line-clamp-2">{r.resultText}</span> : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="dms">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <HeartHandshake className="h-4 w-4 text-slate-500" />
                Взаиморасчёты с ДМС (ОТЧ-19): реестры услуг, оплаты и отказы
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg border max-h-[300px] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Страховая</TableHead>
                      <TableHead>Услуга</TableHead>
                      <TableHead className="w-24">Сумма</TableHead>
                      <TableHead className="w-44">Статус</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.claims.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-sm text-slate-500 py-6">
                          Реестр пуст
                        </TableCell>
                      </TableRow>
                    )}
                    {data.claims.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="text-sm">{c.insurer}</TableCell>
                        <TableCell className="text-xs text-slate-600">{c.serviceName}</TableCell>
                        <TableCell className="text-sm font-mono">{fmtMoney(c.amount)}</TableCell>
                        <TableCell>
                          <Badge className={`text-[10px] ${dmsClass(c.status)}`}>{DMS_STATUS_LABELS[c.status] ?? c.status}</Badge>
                          {c.denyReason && <div className="text-[10px] text-rose-500 mt-0.5">{c.denyReason}</div>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {data.policies.map((p) => (
                  <Badge key={p.id} variant="outline" className="text-[10px] text-slate-600">
                    {p.patientName}: {p.insurer} · {p.policyNumber}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cti">
          <div className="space-y-4">
            {canManage && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <PhoneIncoming className="h-4 w-4 text-amber-500" />
                    CTI-панель регистратуры (ИНТ-003, ФТ-011)
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2 flex-wrap">
                    <Input
                      value={callPhone}
                      onChange={(e) => setCallPhone(e.target.value)}
                      className="h-9 text-sm w-48"
                      aria-label="Телефон звонящего"
                    />
                    <Button size="sm" variant="outline" className="border-amber-300 text-amber-700 hover:bg-amber-50" onClick={simulateCall} disabled={busy}>
                      <PhoneIncoming className="h-3.5 w-3.5 mr-1" /> Входящий звонок
                    </Button>
                  </div>
                  {incoming && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium flex items-center gap-1.5">
                          <PhoneIncoming className="h-4 w-4 text-amber-600 animate-pulse" />
                          Входящий: {incoming.phone}
                        </div>
                        <div className="text-xs text-slate-600 mt-1">
                          {data.calls.length > 0 && incoming.patientId
                            ? `Пациент найден по номеру — карточка открыта`
                            : 'Номер не распознан — поиск по базе'}
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700" onClick={() => setCallStatus(incoming.id, 'ANSWERED')}>
                          <PhoneCall className="h-3 w-3 mr-1" /> Ответить
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs text-rose-600 border-rose-200" onClick={() => setCallStatus(incoming.id, 'MISSED')}>
                          <PhoneOff className="h-3 w-3 mr-1" /> Пропустить
                        </Button>
                      </div>
                    </div>
                  )}
                  {missed.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-xs font-medium text-slate-600">Пропущенные — задачи (перезвонить):</div>
                      {missed.map((c) => (
                        <div key={c.id} className="rounded-lg border p-2 flex items-center justify-between gap-2">
                          <div className="text-xs">
                            <span className="font-mono">{c.phone}</span>
                            <span className="text-slate-400"> · {fmtWhen(c.createdAt)}</span>
                            <Badge className={`ml-2 text-[10px] ${callClass(c.status)}`}>{CALL_STATUS_LABELS[c.status] ?? c.status}</Badge>
                          </div>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setCallStatus(c.id, 'TASK')} disabled={c.status === 'TASK'}>
                            <CheckCircle2 className="h-3 w-3 mr-1" /> {c.status === 'TASK' ? 'Взято в работу' : 'Взять задачу'}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Журнал звонков (дедупликация по event_id, at-least-once)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="rounded-lg border max-h-[280px] overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-32">Время</TableHead>
                        <TableHead>Телефон</TableHead>
                        <TableHead className="w-24">Направление</TableHead>
                        <TableHead className="w-28">Статус</TableHead>
                        <TableHead className="w-24">Запись</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.calls.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell className="text-xs font-mono text-slate-500">{fmtWhen(c.createdAt)}</TableCell>
                          <TableCell className="text-xs font-mono">{c.phone}</TableCell>
                          <TableCell className="text-xs text-slate-500">{c.direction === 'IN' ? 'входящий' : 'исходящий'}</TableCell>
                          <TableCell>
                            <Badge className={`text-[10px] ${callClass(c.status)}`}>{CALL_STATUS_LABELS[c.status] ?? c.status}</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-slate-500">{c.recording ? `${c.duration} с` : '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="outbox">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Activity className="h-4 w-4 text-slate-500" />
                Журнал обмена (transactional outbox, АРХ-004)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border max-h-[400px] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-32">Время</TableHead>
                      <TableHead className="w-24">Система</TableHead>
                      <TableHead>Событие</TableHead>
                      <TableHead className="w-28">Статус</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.events.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-sm text-slate-500 py-6">
                          Событий обмена пока нет
                        </TableCell>
                      </TableRow>
                    )}
                    {data.events.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="text-xs font-mono text-slate-500">{fmtWhen(e.createdAt)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px] font-mono">{e.system}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-slate-600 max-w-96">
                          <div className="truncate" title={e.summary}>{e.summary}</div>
                          {e.error && <div className="text-[10px] text-rose-500">{e.error}</div>}
                        </TableCell>
                        <TableCell>
                          <Badge className={`text-[10px] ${egiszClass(e.status)}`}>{e.status}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={xmlView !== null} onOpenChange={(o) => { if (!o) setXmlView(null) }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <FileCode2 className="h-4 w-4 text-slate-500" />
              CommerceML-XML: {xmlView?.title}
            </DialogTitle>
          </DialogHeader>
          {xmlBusy ? (
            <div className="py-10 text-center text-sm text-slate-500">Загрузка XML…</div>
          ) : (
            <pre
              className="max-h-[480px] overflow-auto rounded-lg border bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-700 whitespace-pre-wrap break-all"
              aria-label="Предпросмотр XML пакета выгрузки 1С"
            >
              {xmlView?.xml ?? ''}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
