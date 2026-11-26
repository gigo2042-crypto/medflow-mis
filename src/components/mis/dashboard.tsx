// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { api } from '@/lib/api'
import { DashboardDTO, STATUS_LABELS, SOURCE_LABELS } from '@/lib/types'
import { statusClass, timeStr } from '@/lib/mis-utils'
import { toast } from 'sonner'
import { BarChart3, CalendarCheck, Wallet, UserX, AlertTriangle, Activity } from 'lucide-react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  BarChart,
  Bar,
  CartesianGrid,
} from 'recharts'

const fmtMoney = new Intl.NumberFormat('ru-RU')

// Дашборд руководителя: KPI, динамика, загрузка врачей, риски неявки (точки улучшения №4 и №9)
export default function DashboardView() {
  const [data, setData] = useState<DashboardDTO | null>(null)

  useEffect(() => {
    api<DashboardDTO>('/api/dashboard')
      .then(setData)
      .catch((e) => toast.error((e as Error).message))
  }, [])

  if (!data) {
    return <div className="text-sm text-slate-500 p-6">Загрузка дашборда...</div>
  }

  const kpis = [
    { title: 'Записей сегодня', value: String(data.todayTotal), icon: CalendarCheck, sub: 'активных записей на текущий день', tone: 'text-emerald-600' },
    { title: 'Завершено приёмов', value: String(data.doneVisits), icon: Activity, sub: 'сегодня с протоколами', tone: 'text-teal-600' },
    { title: 'Выручка сегодня', value: `${fmtMoney.format(data.revenueToday)} ₽`, icon: Wallet, sub: 'по завершённым визитам', tone: 'text-amber-600' },
    { title: 'Неявки, 14 дней', value: `${data.noShowRate14}%`, icon: UserX, sub: 'от завершённых записей', tone: 'text-rose-600' },
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map((k) => {
          const Icon = k.icon
          return (
            <Card key={k.title}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">{k.title}</span>
                  <Icon className={`h-4 w-4 ${k.tone}`} />
                </div>
                <div className="text-2xl font-semibold mt-1 tabular-nums">{k.value}</div>
                <div className="text-xs text-slate-400 mt-0.5">{k.sub}</div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-slate-500 mr-1">Статусы сегодня:</span>
        {Object.entries(data.byStatus).map(([s, n]) => (
          <Badge key={s} className={`text-xs ${statusClass(s)}`}>
            {STATUS_LABELS[s] || s}: {n}
          </Badge>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-emerald-600" /> Записи и неявки, 14 дней
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={data.series} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" fontSize={10} tickLine={false} />
                <YAxis fontSize={10} tickLine={false} allowDecimals={false} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="count" name="Записи" stroke="#059669" fill="#a7f3d0" strokeWidth={2} />
                <Area type="monotone" dataKey="noShows" name="Неявки" stroke="#e11d48" fill="#fecdd3" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Wallet className="h-4 w-4 text-emerald-600" /> Выручка по дням, ₽
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={data.series} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" fontSize={10} tickLine={false} />
                <YAxis fontSize={10} tickLine={false} />
                <Tooltip formatter={(v) => [`${fmtMoney.format(Number(v))} ₽`, 'Выручка']} />
                <Bar dataKey="revenue" name="Выручка" fill="#10b981" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Загрузка врачей сегодня</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.doctors.map((d) => (
              <div key={d.id}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="truncate">
                    {d.name} <span className="text-xs text-slate-400">· {d.specialty}</span>
                  </span>
                  <span className="text-xs text-slate-500 tabular-nums">
                    {d.booked}/{d.total} · {d.percent}%
                  </span>
                </div>
                <Progress value={d.percent} className="h-2" />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" /> Риск неявки — предиктивный скор (zero no-show)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {data.risks.length === 0 && <div className="text-sm text-slate-500">Ближайших приёмов сегодня нет.</div>}
              {data.risks.map((r) => (
                <div key={r.appointmentId} className="rounded-lg border p-2.5 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      {timeStr(new Date(r.start))} · {r.patientName}
                    </div>
                    <div className="text-xs text-slate-500 truncate">
                      {r.doctorName} · {SOURCE_LABELS[r.source]} · {r.hint}
                    </div>
                  </div>
                  <Badge className={`shrink-0 ${r.riskClass}`}>
                    {r.riskLabel} · {r.risk}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
