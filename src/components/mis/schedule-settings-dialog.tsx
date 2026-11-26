// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

// График врачей: рабочие дни недели и часы; исключения — праздники клиники, отпуска, особые часы
import { useCallback, useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { WEEKDAYS } from '@/lib/appointment-rules'
import { todayKey } from '@/lib/mis-utils'
import { toast } from 'sonner'

interface Doc { id: string; name: string; specialty: string; workStart: string; workEnd: string; workDays: string; slotMinutes: number }
interface Ex { id: string; doctorId: string | null; doctorName: string | null; date: string; kind: string; workStart: string | null; workEnd: string | null; reason: string | null }

export default function ScheduleSettingsDialog({ open, onOpenChange, onChanged }: { open: boolean; onOpenChange: (v: boolean) => void; onChanged: () => void }) {
  const [docs, setDocs] = useState<Doc[]>([])
  const [exs, setExs] = useState<Ex[]>([])
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ doctorId: 'ALL', date: todayKey(), dateTo: todayKey(), kind: 'OFF', workStart: '10:00', workEnd: '15:00', reason: '' })

  const load = useCallback(async () => {
    const [d, e] = await Promise.all([api<{ doctors: Doc[] }>('/api/doctors'), api<{ exceptions: Ex[] }>('/api/schedule/exceptions')])
    setDocs(d.doctors)
    setExs(e.exceptions)
  }, [])

  useEffect(() => {
    if (open) load().catch((e) => toast.error((e as Error).message))
  }, [open, load])

  const saveDoc = async (doc: Doc, patch: Partial<Doc>) => {
    setBusy(true)
    try {
      await api(`/api/doctors/${doc.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      setDocs((list) => list.map((d) => (d.id === doc.id ? { ...d, ...patch } : d)))
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const addException = async () => {
    setBusy(true)
    try {
      const r = await api<{ days: number; affectedAppointments: number }>('/api/schedule/exceptions', {
        method: 'POST',
        body: JSON.stringify({ ...form, doctorId: form.doctorId === 'ALL' ? null : form.doctorId }),
      })
      toast.success(`Добавлено дней: ${r.days}${r.affectedAppointments ? ` · записей на эти дни: ${r.affectedAppointments} — перенесите их` : ''}`)
      await load()
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const removeException = async (id: string) => {
    await api(`/api/schedule/exceptions?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch((e) => toast.error((e as Error).message))
    await load()
    onChanged()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>График работы</DialogTitle>
          <DialogDescription>Рабочие дни и часы врачей, праздники клиники, отпуска. На нерабочие дни запись (в том числе через виджет) невозможна.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {docs.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-2 border rounded-md p-2 text-sm">
              <div className="w-48 truncate" title={d.name}>{d.name}</div>
              <div className="flex gap-1">
                {WEEKDAYS.map((w, i) => (
                  <button
                    key={w}
                    disabled={busy}
                    aria-pressed={d.workDays[i] === '1'}
                    onClick={() => saveDoc(d, { workDays: d.workDays.slice(0, i) + (d.workDays[i] === '1' ? '0' : '1') + d.workDays.slice(i + 1) })}
                    className={`h-7 w-8 rounded text-xs border ${d.workDays[i] === '1' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-500'}`}
                  >
                    {w}
                  </button>
                ))}
              </div>
              <Input className="h-8 w-20" aria-label="Начало" defaultValue={d.workStart} onBlur={(e) => e.target.value !== d.workStart && saveDoc(d, { workStart: e.target.value })} />
              <span>–</span>
              <Input className="h-8 w-20" aria-label="Окончание" defaultValue={d.workEnd} onBlur={(e) => e.target.value !== d.workEnd && saveDoc(d, { workEnd: e.target.value })} />
            </div>
          ))}
        </div>

        <div className="border-t pt-3 space-y-2">
          <div className="font-medium text-sm">Исключения (праздники, отпуска, особые часы)</div>
          <div className="flex flex-wrap gap-2 items-end text-sm">
            <Select value={form.doctorId} onValueChange={(v) => setForm({ ...form, doctorId: v })}>
              <SelectTrigger className="h-8 w-52" aria-label="Для кого"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Вся клиника</SelectItem>
                {docs.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input type="date" className="h-8 w-36" aria-label="С" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value, dateTo: e.target.value > form.dateTo ? e.target.value : form.dateTo })} />
            <Input type="date" className="h-8 w-36" aria-label="По" value={form.dateTo} onChange={(e) => setForm({ ...form, dateTo: e.target.value })} />
            <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v })}>
              <SelectTrigger className="h-8 w-40" aria-label="Тип"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="OFF">Нерабочий день</SelectItem>
                <SelectItem value="HOURS">Особые часы</SelectItem>
              </SelectContent>
            </Select>
            {form.kind === 'HOURS' && (
              <>
                <Input className="h-8 w-20" aria-label="С (часы)" value={form.workStart} onChange={(e) => setForm({ ...form, workStart: e.target.value })} />
                <Input className="h-8 w-20" aria-label="До (часы)" value={form.workEnd} onChange={(e) => setForm({ ...form, workEnd: e.target.value })} />
              </>
            )}
            <Input className="h-8 w-48" placeholder="Причина (праздник, отпуск)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            <Button size="sm" disabled={busy} onClick={addException}>Добавить</Button>
          </div>
          <div className="text-xs space-y-1 max-h-48 overflow-y-auto">
            {exs.length === 0 && <div className="text-slate-500">Исключений нет</div>}
            {exs.map((x) => (
              <div key={x.id} className="flex items-center justify-between border-b py-1">
                <span>
                  {x.date} · {x.doctorName ?? 'вся клиника'} · {x.kind === 'OFF' ? 'не работает' : `${x.workStart}–${x.workEnd}`}
                  {x.reason ? ` · ${x.reason}` : ''}
                </span>
                <Button size="sm" variant="ghost" className="h-6 text-rose-600" onClick={() => removeException(x.id)}>Удалить</Button>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
