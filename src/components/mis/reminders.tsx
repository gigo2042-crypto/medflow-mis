// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import ReminderRules from './reminder-rules'
import { Me, can } from '@/lib/rbac'
import {
  CHANNEL_LABELS,
  LEVEL_LABELS,
  REMINDER_STATUS_LABELS,
  ReminderDTO,
  ReminderStats,
  RESPONSE_LABELS,
} from '@/lib/types'
import { ddmmHHMM, pad2 } from '@/lib/mis-utils'
import { toast } from 'sonner'
import { BellRing, RefreshCw, Send, ShieldAlert, ThumbsUp, ThumbsDown, Workflow, Smartphone } from 'lucide-react'

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return `${ddmmHHMM(d)}`
}

function remStatusClass(status: string): string {
  switch (status) {
    case 'SENT':
      return 'bg-emerald-100 text-emerald-700'
    case 'PLANNED':
      return 'bg-slate-100 text-slate-600'
    case 'FAILED':
      return 'bg-rose-100 text-rose-700'
    default:
      return 'bg-slate-100 text-slate-400'
  }
}

// Каскады напоминаний (ФТ-005): за 48/24/3 часа, канал по источнику записи,
// подтверждение/отмена пациентом (кнопки в MAX или ссылка в SMS) с авторепланированием (ТУ-004)
export default function Reminders({ me }: { me: Me }) {
  const canManage = can(me, 'reminders.manage')
  const [reminders, setReminders] = useState<ReminderDTO[]>([])
  const [stats, setStats] = useState<ReminderStats | null>(null)
  const [channelFilter, setChannelFilter] = useState('all')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api<{ reminders: ReminderDTO[]; stats: ReminderStats }>('/api/reminders?take=150')
      setReminders(data.reminders)
      setStats(data.stats)
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
      const res = await api<{ delivery: { sent: number; failed: number; retrying: number; deferredQuiet: number; blockedLimit: number }; remindersSent: number }>(
        '/api/reminders',
        {
          method: 'POST',
          body: JSON.stringify({ action: 'PROCESS' }),
        }
      )
      const d = res.delivery
      const parts: string[] = []
      if (res.remindersSent > 0) parts.push(`напоминаний поставлено в центр: ${res.remindersSent}`)
      if (d.sent) parts.push(`доставлено: ${d.sent}`)
      if (d.retrying) parts.push(`повторы: ${d.retrying}`)
      if (d.deferredQuiet) parts.push(`отложено часами тишины: ${d.deferredQuiet}`)
      if (d.failed) parts.push(`ошибки: ${d.failed}`)
      if (d.blockedLimit) parts.push(`лимит тарифа: ${d.blockedLimit}`)
      toast.success(
        parts.length
          ? `Воркер каскада: ${parts.join(', ')} — доставка через Центр уведомлений (ФТ-013)`
          : 'Очередь пуста — нет напоминаний к отправке прямо сейчас'
      )
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const sendNow = async (r: ReminderDTO) => {
    try {
      const res = await api<{ ok: boolean; notificationStatus: string }>('/api/reminders', {
        method: 'POST',
        body: JSON.stringify({ action: 'SEND_NOW', id: r.id }),
      })
      const st = res.notificationStatus
      if (st === 'SENT') toast.success(`Напоминание доставлено: ${r.patientName}`)
      else if (st === 'DEFERRED_QUIET') toast.info('Отложено часами тишины Центра уведомлений (ФТ-013)')
      else if (st === 'QUEUED') toast.info('Сбой канала — Центр уведомлений повторит отправку (ФТ-013)')
      else if (st === 'FAILED') toast.error('Доставка не удалась: попытки исчерпаны (ФТ-013)')
      else toast.success(`Напоминание поставлено в Центр уведомлений: ${r.patientName}`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const respond = async (r: ReminderDTO, response: 'CONFIRMED' | 'DECLINED') => {
    try {
      const res = await api<{ offeredTo: string | null; appointmentId: string; canceledReminders: number }>(
        '/api/reminders',
        { method: 'POST', body: JSON.stringify({ action: 'RESPOND', id: r.id, response }) }
      )
      if (response === 'CONFIRMED') {
        toast.success(`${r.patientName} подтвердил(а) приём — запись переведена в «Подтверждён»`)
      } else {
        toast.success(
          res.offeredTo
            ? `${r.patientName} отменил(а) приём — слот предложен из листа ожидания: ${res.offeredTo}`
            : `${r.patientName} отменил(а) приём — лист ожидания: подходящих пациентов нет`
        )
      }
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const visible = reminders.filter((r) => channelFilter === 'all' || r.channel === channelFilter)

  const STAT_CARDS: Array<{ label: string; value: number; cls: string }> = [
    { label: 'Запланировано', value: stats?.planned ?? 0, cls: 'bg-slate-100 text-slate-600' },
    { label: 'Отправлено', value: stats?.sent ?? 0, cls: 'bg-emerald-100 text-emerald-700' },
    { label: 'Подтвердили', value: stats?.confirmed ?? 0, cls: 'bg-teal-100 text-teal-700' },
    { label: 'Отменили', value: stats?.declined ?? 0, cls: 'bg-rose-100 text-rose-700' },
    { label: 'Снято при отмене', value: stats?.canceled ?? 0, cls: 'bg-slate-100 text-slate-500' },
    { label: 'Ошибки доставки', value: stats?.failed ?? 0, cls: 'bg-amber-100 text-amber-700' },
  ]

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="flex items-center gap-2 text-base">
              <BellRing className="h-5 w-5 text-emerald-600" />
              Напоминания пациентам
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              {(stats?.dueNow ?? 0) > 0 && (
                <Badge className="bg-amber-100 text-amber-700">к отправке сейчас: {stats?.dueNow}</Badge>
              )}
              <Select value={channelFilter} onValueChange={setChannelFilter}>
                <SelectTrigger className="h-8 w-32 text-xs" aria-label="Фильтр канала">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все каналы</SelectItem>
                  {Object.entries(CHANNEL_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
            {STAT_CARDS.map((c) => (
              <Badge key={c.label} className={c.cls}>
                {c.label}: {c.value}
              </Badge>
            ))}
          </div>
          <p className="text-xs text-slate-500 pt-1">
            Каскад по каждой записи — по правилам ниже (по умолчанию 48 ч → 24 ч → 3 ч); канал — MAX, если пациент подключил бота клиники
            (по ссылке-приглашению из карточки пациента), иначе SMS; при сбое MAX сообщение уходит по SMS. Пациент подтверждает или
            отменяет запись кнопками в MAX или по ссылке из SMS (ответные SMS «1»/«2» шлюз не принимает) — отмена автоматически
            возвращает слот в лист ожидания.
          </p>
        </CardHeader>
        <CardContent>
          {!canManage && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
              Ваша роль видит журнал напоминаний (reminders.read); отправка и фиксация ответов — у регистратуры и
              администратора (reminders.manage).
            </div>
          )}
          <div className="rounded-lg border max-h-[520px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Пациент</TableHead>
                  <TableHead>Приём</TableHead>
                  <TableHead className="w-20">Уровень</TableHead>
                  <TableHead className="w-28">Канал</TableHead>
                  <TableHead className="w-36">Планируется</TableHead>
                  <TableHead className="w-28">Статус</TableHead>
                  <TableHead className="w-28">Ответ</TableHead>
                  {canManage && <TableHead className="w-44">Действия</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={canManage ? 8 : 7} className="text-center text-sm text-slate-500 py-8">
                      Напоминаний нет — создайте запись или подождите каскада
                    </TableCell>
                  </TableRow>
                )}
                {visible.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="text-sm font-medium truncate">{r.patientName}</div>
                      <div className="text-xs text-slate-500">{r.patientPhone}</div>
                    </TableCell>
                    <TableCell>
                      <div className="text-xs text-slate-600">{r.doctorName}</div>
                      <div className="text-xs text-slate-500 font-mono">{fmtWhen(r.start)}</div>
                      {r.appointmentStatus === 'CONFIRMED' && (
                        <Badge className="mt-0.5 text-[10px] bg-teal-100 text-teal-700">приём подтверждён</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] text-slate-600">
                        {LEVEL_LABELS[r.level] ?? r.level}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-slate-600 flex items-center gap-1">
                        <Smartphone className="h-3 w-3 text-slate-400" />
                        {CHANNEL_LABELS[r.channel] ?? r.channel}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-slate-500 font-mono">{fmtWhen(r.plannedAt)}</span>
                      {r.sentAt && <div className="text-[10px] text-emerald-600">отправлено {fmtWhen(r.sentAt)}</div>}
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-[10px] ${remStatusClass(r.status)}`}>
                        {REMINDER_STATUS_LABELS[r.status] ?? r.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {r.response ? (
                        <Badge className={`text-[10px] ${r.response === 'CONFIRMED' ? 'bg-teal-100 text-teal-700' : 'bg-rose-100 text-rose-700'}`}>
                          {RESPONSE_LABELS[r.response]}
                        </Badge>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {r.status === 'PLANNED' && (
                            <Button size="sm" variant="outline" className="h-7 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-50" onClick={() => sendNow(r)}>
                              <Send className="h-3 w-3 mr-1" /> Отправить
                            </Button>
                          )}
                          {r.status === 'SENT' && !r.response && (
                            <>
                              <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700" onClick={() => respond(r, 'CONFIRMED')} title="Ответ «1 — подтверждаю»">
                                <ThumbsUp className="h-3 w-3 mr-1" /> 1
                              </Button>
                              <Button size="sm" variant="outline" className="h-7 text-xs border-rose-200 text-rose-600 hover:bg-rose-50" onClick={() => respond(r, 'DECLINED')} title="Ответ «2 — отменяю»">
                                <ThumbsDown className="h-3 w-3 mr-1" /> 2
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-slate-400 pt-2">
            Доставка каскада идёт через Центр уведомлений (ФТ-013): часы тишины, повторные попытки, лимиты тарифа и
            чёрные списки — см. вкладку «Центр уведомлений». Тексты каскада задаются шаблонами центра.
          </p>
        </CardContent>
      </Card>

      <ReminderRules canManage={canManage} />
    </div>
  )
}
