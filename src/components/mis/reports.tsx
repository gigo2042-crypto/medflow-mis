// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { Me } from '@/lib/rbac'
import { CatalogItemDTO, ReportDTO, REPORT_SECTIONS } from '@/lib/types'
import ReportScheduler from './report-scheduler'
import { toast } from 'sonner'
import { FileSpreadsheet, RefreshCw, BarChart3, Download, CalendarRange, Lock } from 'lucide-react'
import { dateKey } from '@/lib/mis-utils'

interface ReportsData {
  catalog: CatalogItemDTO[]
  section: string
  period: { from: string; to: string }
  reports: ReportDTO[]
}

function ymd(d: Date): string {
  return dateKey(d)
}

// Отчётность (ОТЧ-01..36): операционные и аналитические отчёты с фильтром
// периода; каталог фиксирует полный перечень ТЗ, включая этапы v2/v3.
// Экспорт — CSV (в проде: .xlsx, PDF, планировщик выгрузок — ТЗ гл. 9).
export default function Reports({ me }: { me: Me }) {
  const [section, setSection] = useState('operations')
  const [from, setFrom] = useState(ymd(new Date(Date.now() - 30 * 86400_000)))
  const [to, setTo] = useState(ymd(new Date()))
  const [data, setData] = useState<ReportsData | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (sec: string) => {
    try {
      const d = await api<ReportsData>(`/api/reports?section=${sec}&from=${new Date(from).getTime()}&to=${new Date(to).getTime() + 86400_000}`)
      setData(d)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [from, to])

  useEffect(() => {
    load(section)
  }, [load, section])

  const catalogBySection = useMemo(() => {
    if (!data) return [] as CatalogItemDTO[]
    return data.catalog.filter((c) => c.section === section)
  }, [data, section])

  const exportCsv = (r: ReportDTO) => {
    const lines = [r.columns.map((c) => c.label).join(';')]
    for (const row of r.rows) {
      lines.push(row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';'))
    }
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${r.code}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`${r.code}: выгружено ${r.rows.length} строк (CSV)`)
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-slate-500">Формирование отчётов…</CardContent>
      </Card>
    )
  }

  const implementedTotal = data.catalog.filter((c) => c.implemented).length

  return (
    <div className="space-y-4">
      <ReportScheduler me={me} />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="h-5 w-5 text-emerald-600" />
              Отчётность
              <Badge className="bg-emerald-100 text-emerald-700">{implementedTotal} из 36 доступно</Badge>
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <CalendarRange className="h-4 w-4 text-slate-400" />
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-8 text-xs w-32"
                aria-label="Начало периода"
              />
              <span className="text-xs text-slate-400">—</span>
              <Input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-8 text-xs w-32"
                aria-label="Конец периода"
              />
              <Button size="sm" variant="outline" onClick={() => load(section)} title="Пересчитать">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <p className="text-xs text-slate-500 pt-1">
            Операционные отчёты — по транзакционным данным; аналитические витрины — агрегаты на лету (в проде — ClickHouse
            через CDC-контур, АРХ-004/006). Полный каталог ОТЧ-01…36 ниже по разделам; запланированные отчёты этапа
            v2/v3 отображаются серым.
          </p>
        </CardHeader>
        <CardContent>
          <Tabs value={section} onValueChange={setSection}>
            <TabsList className="flex-wrap h-auto">
              {REPORT_SECTIONS.map((s) => (
                <TabsTrigger key={s.key} value={s.key}>{s.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className="flex flex-wrap gap-1.5 pt-3">
            {catalogBySection.map((c) => (
              <Badge
                key={c.code}
                variant="outline"
                className={`text-[10px] ${c.implemented ? 'border-emerald-200 text-emerald-700' : 'text-slate-400'}`}
              >
                {c.code} · {c.stage}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {data.reports.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-500">
            В разделе нет реализованных отчётов — они на этапах v2/v3 (см. каталог ТЗ)
          </CardContent>
        </Card>
      )}

      {data.reports.map((r) => (
        <Card key={r.code}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <CardTitle className="text-sm flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-slate-500" />
                <Badge variant="outline" className="font-mono text-[10px]">{r.code}</Badge>
                {r.name}
              </CardTitle>
              <Button size="sm" variant="outline" onClick={() => exportCsv(r)} title="Экспорт CSV">
                <Download className="h-3.5 w-3.5 mr-1" /> CSV
              </Button>
            </div>
            <p className="text-xs text-slate-500">{r.note}</p>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border max-h-[340px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {r.columns.map((c) => (
                      <TableHead key={c.key}>{c.label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={r.columns.length} className="text-center text-sm text-slate-500 py-6">
                        Нет данных за выбранный период
                      </TableCell>
                    </TableRow>
                  )}
                  {r.rows.map((row, i) => (
                    <TableRow key={i}>
                      {row.map((v, j) => (
                        <TableCell key={j} className="text-xs whitespace-nowrap">
                          {j === 0 ? <span className="text-sm font-medium">{String(v)}</span> : String(v)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Lock className="h-4 w-4 text-slate-400" />
            Запланировано этапами v2/v3 (каталог ТЗ)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {data.catalog.filter((c) => !c.implemented).map((c) => (
              <Badge key={c.code} variant="outline" className="text-[10px] text-slate-400">
                {c.code} · {c.name} · {c.stage}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
