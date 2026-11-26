// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import { Me, can } from '@/lib/rbac'
import { SOURCE_LABELS, TodayRiskDTO, TodayRisksDTO } from '@/lib/types'
import { timeStr } from '@/lib/mis-utils'
import { toast } from 'sonner'
import { ShieldAlert, TrendingUp, PhoneCall, MessageSquareWarning, UserX, RefreshCw, ChevronDown, Users } from 'lucide-react'

interface Props {
  me: Me
  onChanged?: () => void
}

function fmtTime(iso: string): string {
  return timeStr(new Date(iso))
}

function impactClass(impact: number): string {
  if (impact >= 10) return 'bg-rose-100 text-rose-700'
  if (impact > 0) return 'bg-amber-50 text-amber-700 border border-amber-200'
  if (impact <= -10) return 'bg-emerald-100 text-emerald-700'
  return 'bg-emerald-50 text-emerald-700 border border-emerald-200'
}

// Панель регистратуры «Риски на сегодня» (ТУ-004, v2): предиктивный скор
// неявки по каждому приёму, факторы модели и сценарии обработки — звонок,
// срочное касание через Центр уведомлений, фиксация неявки с автоприглашением
// из листа ожидания.
export default function RisksPanel({ me, onChanged }: Props) {
  const canUpdate = can(me, 'appointments.update')
  const [data, setData] = useState<TodayRisksDTO | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api<TodayRisksDTO>('/api/no-show-risks')
      setData(d)
    } catch (e) {
      // панель рисков вторична — не засоряем тостами при 403 (врачи не имеют schedule.read)
      console.warn('[risks]', (e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
    const poll = setInterval(load, 15000)
    return () => clearInterval(poll)
  }, [load])

  const act = async (item: TodayRiskDTO, action: 'CALL' | 'TOUCH' | 'MARK_NO_SHOW') => {
    setBusyId(item.appointmentId)
    try {
      const res = await api<{ ok?: boolean; notificationStatus?: string; offeredTo?: string | null }>('/api/no-show-risks', {
        method: 'POST',
        body: JSON.stringify({ action, id: item.appointmentId }),
      })
      if (action === 'CALL') {
        toast.success(`Звонок зафиксирован в аудите: ${item.patientName}`)
      } else if (action === 'TOUCH') {
        const st = res.notificationStatus
        if (st === 'SENT') toast.success(`Срочное касание доставлено: ${item.patientName}`)
        else if (st === 'DEFERRED_QUIET') toast.info(`Касание отложено часами тишины (ФТ-013)`)
        else if (st === 'QUEUED') toast.info(`Касание в очереди — сбой канала, будет повтор (ФТ-013)`)
        else if (st === 'FAILED') toast.error(`Касание не доставлено: канал недоступен (ФТ-013)`)
        else toast.success(`Касание поставлено в Центр уведомлений`)
      } else {
        toast.success(`Неявка зафиксирована: ${item.patientName}`)
        if (res.offeredTo) {
          const st = res.notificationStatus
          const via =
            st === 'SENT'
              ? ' — приглашение отправлено (срочно, в обход тишины)'
              : st === 'DEFERRED_QUIET'
                ? ' — приглашение отложено часами тишины'
                : st === 'QUEUED'
                  ? ' — приглашение в очереди центра'
                  : ''
          toast.info(`Слот предложен из листа ожидания: ${res.offeredTo}${via}`)
        } else {
          toast.info('Подходящих пациентов в листе ожидания на этот слот нет')
        }
      }
      await load()
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  if (!data) return null
  const risky = data.items.filter((i) => i.score >= 30)
  if (risky.length === 0) {
    return (
      <Card>
        <CardContent className="p-4 flex items-center gap-2 text-sm text-slate-500">
          <ShieldAlert className="h-4 w-4 text-emerald-500" />
          Риски на сегодня: высокий риск неявки не выявлен — {data.totals.checked} приёмов проверено скором ТУ-004
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-5 w-5 text-rose-500" />
            Риски на сегодня
            <Badge className="bg-rose-100 text-rose-700">высокий: {data.totals.high}</Badge>
            <Badge className="bg-amber-100 text-amber-700">средний: {data.totals.medium}</Badge>
          </CardTitle>
          <Button size="sm" variant="ghost" onClick={load} title="Пересчитать скор">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <p className="text-xs text-slate-500 pt-1">
          Предиктивный скор неявки (ТУ-004 v2): история пациента, источник записи, результат подтверждения, срок до
          визита, направление, день недели и время. Ниже — приёмы со скором ≥ 30 и сценарии обработки.
        </p>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 max-h-[560px] overflow-y-auto pr-1">
          {risky.map((item) => {
            const isOpen = expanded.has(item.appointmentId)
            const busy = busyId === item.appointmentId
            return (
              <div key={item.appointmentId} className="rounded-lg border p-3 bg-white">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-mono text-sm font-medium">{fmtTime(item.start)}</span>
                      <span className="text-sm font-medium truncate">{item.patientName}</span>
                      <Badge className={`text-[10px] ${item.scoreClass}`}>
                        скор {item.score} · {item.scoreLabel}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] text-slate-500">
                        {SOURCE_LABELS[item.source] ?? item.source}
                      </Badge>
                      {item.waitlistCandidates > 0 && (
                        <Badge className="text-[10px] bg-teal-100 text-teal-700" title={`Первый в очереди: ${item.waitlistFirst ?? ''}`}>
                          <Users className="h-3 w-3 mr-0.5" /> замена из очереди: {item.waitlistCandidates}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 truncate">
                      {item.doctorName} · {item.doctorSpecialty} · {item.patientPhone}
                    </div>
                  </div>
                  {canUpdate && (
                    <div className="flex flex-wrap gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => act(item, 'CALL')}
                        disabled={busy}
                        title={item.scenarioAction}
                      >
                        <PhoneCall className="h-3 w-3 mr-1" /> Позвонили
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-violet-200 text-violet-700 hover:bg-violet-50"
                        onClick={() => act(item, 'TOUCH')}
                        disabled={busy}
                        title="Срочное сообщение через Центр уведомлений (ФТ-013)"
                      >
                        <MessageSquareWarning className="h-3 w-3 mr-1" /> SMS-касание
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs text-rose-600 border-rose-200 hover:bg-rose-50"
                        onClick={() => act(item, 'MARK_NO_SHOW')}
                        disabled={busy}
                        title="Фиксация неявки: слот уйдёт листу ожидания автоматически"
                      >
                        <UserX className="h-3 w-3 mr-1" /> Неявка
                      </Button>
                    </div>
                  )}
                </div>
                <div className="mt-1.5">
                  <button
                    className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev)
                        if (next.has(item.appointmentId)) next.delete(item.appointmentId)
                        else next.add(item.appointmentId)
                        return next
                      })
                    }
                    aria-expanded={isOpen}
                  >
                    <ChevronDown className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                    {item.scenarioAction}: {item.scenarioHint}
                  </button>
                  {isOpen && (
                    <div className="flex flex-wrap gap-1 pt-1.5">
                      {item.factors.map((f, idx) => (
                        <span key={idx} className={`text-[10px] rounded px-1.5 py-0.5 ${impactClass(f.impact)}`}>
                          {f.impact > 0 ? '+' : ''}{f.impact} · {f.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
