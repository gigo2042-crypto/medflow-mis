// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { Me, can } from '@/lib/rbac'
import {
  CHANNEL_LABELS,
  NotificationDTO,
  NOTIFY_KIND_LABELS,
  NOTIFY_STATUS_LABELS,
  NotifyBlacklistDTO,
  NotifySettingsDTO,
  NotifyStatsDTO,
  NotifyTemplateDTO,
  notifyStatusClass,
} from '@/lib/types'
import { ddmmHHMM, pad2, timeStr } from '@/lib/mis-utils'
import { toast } from 'sonner'
import {
  BellRing, RefreshCw, Workflow, Inbox, Moon, Ban, ShieldAlert, Send, Plus, Trash2,
  Save, AlertTriangle, Gauge, FileText, Lock,
} from 'lucide-react'

interface CenterData {
  notifications: NotificationDTO[]
  stats: NotifyStatsDTO
  settings: NotifySettingsDTO
  templates: NotifyTemplateDTO[]
  blacklist: NotifyBlacklistDTO[]
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return `${ddmmHHMM(d)}`
}

// Центр уведомлений (ФТ-013): единый исходящий контур МИС — журнал доставки,
// часы тишины, чёрные списки, лимиты тарифа, повторные попытки, шаблоны.
// Через центр доставляются напоминания (ФТ-005) и приглашения из листа
// ожидания (ТУ-004 v2: предиктивные автоприглашения).
export default function NotificationCenter({ me }: { me: Me }) {
  const canManage = can(me, 'notifications.manage')
  const [data, setData] = useState<CenterData | null>(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Ручное сообщение
  const [manualPhone, setManualPhone] = useState('')
  const [manualText, setManualText] = useState('')
  const [manualChannel, setManualChannel] = useState('SMS')

  // Настройки (черновик)
  const [draft, setDraft] = useState<NotifySettingsDTO | null>(null)
  const [blPhone, setBlPhone] = useState('')
  const [blReason, setBlReason] = useState('')
  const [tplDrafts, setTplDrafts] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      const d = await api<CenterData>('/api/notifications?take=150')
      setData(d)
      setDraft((prev) => prev ?? d.settings)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
    const poll = setInterval(load, 10000)
    return () => clearInterval(poll)
  }, [load])

  const processQueue = async () => {
    setBusy(true)
    try {
      const res = await api<{ delivery: { sent: number; failed: number; retrying: number; deferredQuiet: number; blockedLimit: number } }>(
        '/api/notifications',
        { method: 'POST', body: JSON.stringify({ action: 'PROCESS' }) }
      )
      const d = res.delivery
      const parts: string[] = []
      if (d.sent) parts.push(`доставлено ${d.sent}`)
      if (d.retrying) parts.push(`повторы ${d.retrying}`)
      if (d.deferredQuiet) parts.push(`отложено часами тишины ${d.deferredQuiet}`)
      if (d.failed) parts.push(`ошибки ${d.failed}`)
      if (d.blockedLimit) parts.push(`лимит ${d.blockedLimit}`)
      toast.success(parts.length ? `Воркер центра: ${parts.join(', ')}` : 'Очередь пуста — всё доставлено')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const sendManual = async () => {
    try {
      const res = await api<{ ok: boolean; status: string }>('/api/notifications', {
        method: 'POST',
        body: JSON.stringify({ action: 'SEND_MANUAL', phone: manualPhone, text: manualText, channel: manualChannel }),
      })
      toast.success(
        res.status === 'SENT'
          ? 'Сообщение доставлено'
          : `Поставлено в очередь (статус: ${NOTIFY_STATUS_LABELS[res.status] ?? res.status})`
      )
      setManualPhone('')
      setManualText('')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const saveSettings = async () => {
    if (!draft) return
    try {
      await api('/api/notifications', {
        method: 'POST',
        body: JSON.stringify({ action: 'UPDATE_SETTINGS', ...draft }),
      })
      toast.success('Настройки центра сохранены')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const addToBlacklist = async () => {
    try {
      await api('/api/notifications', {
        method: 'POST',
        body: JSON.stringify({ action: 'TOGGLE_BLACKLIST', phone: blPhone, reason: blReason }),
      })
      toast.success(`Телефон добавлен в чёрный список: ${blPhone}`)
      setBlPhone('')
      setBlReason('')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const removeFromBlacklist = async (phone: string) => {
    try {
      await api('/api/notifications', {
        method: 'POST',
        body: JSON.stringify({ action: 'TOGGLE_BLACKLIST', phone, remove: true }),
      })
      toast.success(`Телефон исключён: ${phone}`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const saveTemplate = async (t: NotifyTemplateDTO) => {
    try {
      await api('/api/notifications', {
        method: 'POST',
        body: JSON.stringify({ action: 'UPDATE_TEMPLATE', id: t.id, body: tplDrafts[t.id] ?? t.body }),
      })
      toast.success(`Шаблон «${t.name}» сохранён`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const toggleTemplate = async (t: NotifyTemplateDTO, active: boolean) => {
    try {
      await api('/api/notifications', {
        method: 'POST',
        body: JSON.stringify({ action: 'UPDATE_TEMPLATE', id: t.id, active }),
      })
      toast.success(active ? `Шаблон «${t.name}» включён` : `Шаблон «${t.name}» выключен — каскад пойдёт по тексту по умолчанию`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (!data || !draft) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-slate-500">Загрузка центра уведомлений…</CardContent>
      </Card>
    )
  }

  const s = data.stats
  const visible = data.notifications.filter((n) => statusFilter === 'all' || n.status === statusFilter)
  const tariffUsed = Math.min(100, Math.round((s.sentToday / Math.max(1, s.dailyLimit)) * 100))

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="flex items-center gap-2 text-base">
              <Inbox className="h-5 w-5 text-emerald-600" />
              Центр уведомлений
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="outline" onClick={load} title="Обновить">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              {canManage && (
                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={processQueue} disabled={busy}>
                  <Workflow className="h-3.5 w-3.5 mr-1" />
                  {busy ? 'Обработка...' : 'Обработать очередь'}
                </Button>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Badge className="bg-slate-100 text-slate-600">в очереди: {s.queued + s.deferredQuiet}</Badge>
            <Badge className="bg-emerald-100 text-emerald-700">доставлено: {s.sent}</Badge>
            <Badge className="bg-rose-100 text-rose-700">не доставлено: {s.failed}</Badge>
            <Badge className="bg-amber-100 text-amber-800">чёрный список: {s.blockedBlacklist}</Badge>
            {s.blockedLimit > 0 && <Badge className="bg-orange-100 text-orange-700">лимит тарифа: {s.blockedLimit}</Badge>}
            <Badge variant="outline" className={s.quietActive ? 'border-violet-300 text-violet-700' : 'text-slate-500'}>
              <Moon className="h-3 w-3 mr-1" />
              {s.quietActive
                ? `часы тишины активны до ${timeStr(new Date(s.quietEnd as string))}`
                : `часы тишины: ${data.settings.quietFrom}–${data.settings.quietTo}`}
            </Badge>
          </div>
          <div className="flex items-center gap-2 pt-1.5 text-xs text-slate-500">
            <Gauge className="h-3.5 w-3.5 text-slate-400" />
            <span className="whitespace-nowrap">
              Тариф: {s.sentToday} / {s.dailyLimit} сообщений за сегодня
            </span>
            <Progress value={tariffUsed} className="h-1.5 max-w-48" aria-label="Использование дневного лимита тарифа" />
          </div>
          <p className="text-xs text-slate-500 pt-1">
            Единый исходящий контур: напоминания (ФТ-005), приглашения из листа ожидания (ТУ-004) и касания по рискам
            доставляются только через центр — с повторными попытками {s.retryMinutes} мин (до {s.maxAttempts}), часами тишины
            и лимитами тарифа.
          </p>
        </CardHeader>
        {!canManage && (
          <CardContent className="pt-0">
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
              Ваша роль видит журнал доставки (notifications.read); воркер, настройки, чёрный список и шаблоны — у
              регистратуры и администратора (notifications.manage).
            </div>
          </CardContent>
        )}
      </Card>

      <Tabs defaultValue="journal">
        <TabsList className="mb-3 flex-wrap h-auto">
          <TabsTrigger value="journal">Журнал доставки</TabsTrigger>
          {canManage && <TabsTrigger value="manual">Ручная отправка</TabsTrigger>}
          {canManage && <TabsTrigger value="settings">Настройки</TabsTrigger>}
          {canManage && <TabsTrigger value="blacklist">Чёрный список</TabsTrigger>}
          {canManage && <TabsTrigger value="templates">Шаблоны</TabsTrigger>}
        </TabsList>

        <TabsContent value="journal">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <CardTitle className="text-sm flex items-center gap-2">
                  <BellRing className="h-4 w-4 text-slate-500" />
                  Исходящие сообщения
                </CardTitle>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-8 w-40 text-xs" aria-label="Фильтр статуса">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Все статусы</SelectItem>
                    {Object.entries(NOTIFY_STATUS_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border max-h-[460px] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Получатель</TableHead>
                      <TableHead className="w-44">Тип · канал</TableHead>
                      <TableHead>Текст</TableHead>
                      <TableHead className="w-24">Попытки</TableHead>
                      <TableHead className="w-36">Статус</TableHead>
                      <TableHead className="w-24">Создано</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-sm text-slate-500 py-8">
                          Сообщений нет — обработайте очередь напоминаний или отмените запись, чтобы увидеть автоприглашение
                        </TableCell>
                      </TableRow>
                    )}
                    {visible.map((n) => {
                      const isOpen = expanded.has(n.id)
                      return (
                        <TableRow key={n.id}>
                          <TableCell>
                            <div className="text-sm font-medium truncate max-w-40">
                              {n.patientName || <span className="text-slate-400">внешний номер</span>}
                            </div>
                            <div className="text-xs text-slate-500 font-mono">{n.phone}</div>
                          </TableCell>
                          <TableCell>
                            <div className="text-xs text-slate-700">{NOTIFY_KIND_LABELS[n.kind] ?? n.kind}</div>
                            <div className="text-xs text-slate-500 flex items-center gap-1">
                              {CHANNEL_LABELS[n.channel] ?? n.channel}
                              {n.fallbackFrom ? ` (вместо ${CHANNEL_LABELS[n.fallbackFrom] ?? n.fallbackFrom})` : ''}
                              {n.priority === 1 && <Badge className="text-[9px] px-1 py-0 bg-rose-100 text-rose-600">срочно</Badge>}
                            </div>
                          </TableCell>
                          <TableCell className="max-w-96">
                            <div
                              className={`text-xs text-slate-600 ${isOpen ? '' : 'line-clamp-2'} cursor-pointer`}
                              onClick={() =>
                                setExpanded((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(n.id)) next.delete(n.id)
                                  else next.add(n.id)
                                  return next
                                })
                              }
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click()
                              }}
                              title={n.text}
                            >
                              {n.text}
                            </div>
                            {n.error && (
                              <div className="text-[10px] text-rose-500 flex items-center gap-1 mt-0.5">
                                <AlertTriangle className="h-3 w-3" /> {n.error}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-slate-500 font-mono">
                              {n.attempts}/{n.maxAttempts}
                            </span>
                            {['QUEUED', 'DEFERRED_QUIET'].includes(n.status) && (
                              <div className="text-[10px] text-slate-400">
                                след. попытка {fmtWhen(n.nextAttemptAt)}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge className={`text-[10px] ${notifyStatusClass(n.status)}`}>
                              {NOTIFY_STATUS_LABELS[n.status] ?? n.status}
                            </Badge>
                            {n.sentAt && <div className="text-[10px] text-emerald-600 mt-0.5">{fmtWhen(n.sentAt)}</div>}
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-slate-400 font-mono">{fmtWhen(n.createdAt)}</span>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-slate-400 pt-2">
                Кликните по тексту, чтобы развернуть сообщение. «Срочно» обходит часы тишины: приглашения из листа
                ожидания (TTL слота 15 минут) и касания по высокому риску.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {canManage && (
          <TabsContent value="manual">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Send className="h-4 w-4 text-slate-500" />
                  Ручное сообщение пациенту
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 max-w-xl">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="manual-phone" className="text-xs">Телефон</Label>
                    <Input
                      id="manual-phone"
                      value={manualPhone}
                      onChange={(e) => setManualPhone(e.target.value)}
                      placeholder="+7 900 000-00-00"
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Канал</Label>
                    <Select value={manualChannel} onValueChange={setManualChannel}>
                      <SelectTrigger className="h-9 text-sm" aria-label="Канал отправки">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {/* по произвольному номеру — только SMS и e-mail: MAX пишет лишь привязанным пациентам */}
                        <SelectItem value="SMS">SMS</SelectItem>
                        <SelectItem value="EMAIL">E-mail</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="manual-text" className="text-xs">Текст сообщения</Label>
                  <Textarea
                    id="manual-text"
                    value={manualText}
                    onChange={(e) => setManualText(e.target.value)}
                    placeholder="Уважаемый(ая) Иван! Клиника MedFlow поздравляет с днём рождения и дарит скидку 10% на гигиену…"
                    className="text-sm min-h-20"
                  />
                </div>
                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={sendManual} disabled={manualPhone.trim().length < 10 || manualText.trim().length < 3}>
                  <Send className="h-3.5 w-3.5 mr-1" /> Отправить через центр
                </Button>
                <p className="text-xs text-slate-400">
                  Отправка идёт с проверками: чёрный список, часы тишины, лимит тарифа, повторные попытки.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {canManage && (
          <TabsContent value="settings">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Moon className="h-4 w-4 text-violet-500" />
                  Часы тишины, лимит тарифа и повторные попытки
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 max-w-3xl">
                  <div className="space-y-1.5">
                    <Label htmlFor="quiet-from" className="text-xs">Часы тишины — с</Label>
                    <Input
                      id="quiet-from"
                      type="time"
                      value={draft.quietFrom}
                      onChange={(e) => setDraft({ ...draft, quietFrom: e.target.value })}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="quiet-to" className="text-xs">до</Label>
                    <Input
                      id="quiet-to"
                      type="time"
                      value={draft.quietTo}
                      onChange={(e) => setDraft({ ...draft, quietTo: e.target.value })}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="daily-limit" className="text-xs">Лимит тарифа/сутки</Label>
                    <Input
                      id="daily-limit"
                      type="number"
                      min={1}
                      value={draft.dailyLimit}
                      onChange={(e) => setDraft({ ...draft, dailyLimit: Number(e.target.value) })}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="retry-minutes" className="text-xs">Интервал повтора, мин</Label>
                    <Input
                      id="retry-minutes"
                      type="number"
                      min={1}
                      value={draft.retryMinutes}
                      onChange={(e) => setDraft({ ...draft, retryMinutes: Number(e.target.value) })}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="max-attempts" className="text-xs">Попыток доставки</Label>
                    <Input
                      id="max-attempts"
                      type="number"
                      min={1}
                      value={draft.maxAttempts}
                      onChange={(e) => setDraft({ ...draft, maxAttempts: Number(e.target.value) })}
                      className="h-9 text-sm"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={saveSettings}>
                    <Save className="h-3.5 w-3.5 mr-1" /> Сохранить настройки
                  </Button>
                  <span className="text-xs text-slate-400">
                    Ночью несрочные сообщения откладываются до конца окна тишины.
                  </span>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {canManage && (
          <TabsContent value="blacklist">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Ban className="h-4 w-4 text-amber-500" />
                  Чёрные списки рассылок
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 max-w-2xl">
                  <Input
                    value={blPhone}
                    onChange={(e) => setBlPhone(e.target.value)}
                    placeholder="Телефон +7…"
                    className="h-9 text-sm"
                    aria-label="Телефон для чёрного списка"
                  />
                  <Input
                    value={blReason}
                    onChange={(e) => setBlReason(e.target.value)}
                    placeholder="Причина (отказ от рассылок, жалоба…)"
                    className="h-9 text-sm"
                    aria-label="Причина блокировки"
                  />
                  <Button size="sm" variant="outline" onClick={addToBlacklist} disabled={blPhone.trim().length < 10}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Добавить
                  </Button>
                </div>
                <div className="rounded-lg border max-h-56 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Телефон</TableHead>
                        <TableHead>Причина</TableHead>
                        <TableHead className="w-32">Добавлен</TableHead>
                        <TableHead className="w-16" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.blacklist.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-sm text-slate-500 py-6">
                            Чёрный список пуст
                          </TableCell>
                        </TableRow>
                      )}
                      {data.blacklist.map((b) => (
                        <TableRow key={b.id}>
                          <TableCell className="font-mono text-sm">{b.phone}</TableCell>
                          <TableCell className="text-xs text-slate-600">{b.reason ?? '—'}</TableCell>
                          <TableCell className="text-xs text-slate-400 font-mono">{fmtWhen(b.createdAt)}</TableCell>
                          <TableCell>
                            <Button size="sm" variant="ghost" onClick={() => removeFromBlacklist(b.phone)} title="Убрать из списка">
                              <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <p className="text-xs text-slate-400">
                  Телефон в списке блокирует любые автоматические и ручные отправки: напоминания, приглашения, касания.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {canManage && (
          <TabsContent value="templates">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {data.templates.map((t) => (
                <Card key={t.id}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <FileText className="h-4 w-4 text-slate-500" />
                        {t.name}
                      </CardTitle>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px] font-mono">{t.code}</Badge>
                        <Switch checked={t.active} onCheckedChange={(v) => toggleTemplate(t, v)} aria-label={`Шаблон ${t.name}`} />
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <Badge className="text-[10px] bg-slate-100 text-slate-600">{NOTIFY_KIND_LABELS[t.kind] ?? t.kind}</Badge>
                      <Badge className="text-[10px] bg-slate-100 text-slate-600">{CHANNEL_LABELS[t.channel] ?? t.channel}</Badge>
                      {!t.active && <Badge className="text-[10px] bg-rose-100 text-rose-600">выключен — текст по умолчанию</Badge>}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <Textarea
                      value={tplDrafts[t.id] ?? t.body}
                      onChange={(e) => setTplDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                      className="text-xs min-h-28 font-mono"
                      aria-label={`Текст шаблона ${t.name}`}
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-slate-400">
                        {'Подстановки: {{patient.firstName}}, {{doctor.name}}, {{start.date}}, {{start.time}}, {{clinic.name}}'}
                      </span>
                      <Button size="sm" variant="outline" onClick={() => saveTemplate(t)} disabled={(tplDrafts[t.id] ?? t.body).trim().length < 5}>
                        <Save className="h-3.5 w-3.5 mr-1" /> Сохранить
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>
        )}

        {!canManage && (
          <Card>
            <CardContent className="p-6 flex items-center gap-2 text-sm text-slate-500">
              <Lock className="h-4 w-4" /> Настройки, чёрный список и шаблоны доступны ролям с правом notifications.manage
            </CardContent>
          </Card>
        )}
      </Tabs>
    </div>
  )
}
