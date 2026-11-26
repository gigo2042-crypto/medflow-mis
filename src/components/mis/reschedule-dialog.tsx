// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { DoctorSchedule } from '@/lib/types'
import { dateKey, ddmmHHMM, todayKey } from '@/lib/mis-utils'
import { toast } from 'sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export interface RescheduleTarget {
  id: string
  patientName: string
  doctorId: string
  start: string
}

// Перенос записи (чеклист п.9): выбор дня, врача и свободного слота → PATCH action RESCHEDULE
export function RescheduleDialog({ target, onClose, onDone }: { target: RescheduleTarget | null; onClose: () => void; onDone: () => void }) {
  const [day, setDay] = useState(todayKey())
  const [doctorId, setDoctorId] = useState('')
  const [schedules, setSchedules] = useState<DoctorSchedule[]>([])
  const [slot, setSlot] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!target) return
    setDay(dateKey(new Date(target.start)) < todayKey() ? todayKey() : dateKey(new Date(target.start)))
    setDoctorId(target.doctorId)
    setSlot('')
  }, [target])

  useEffect(() => {
    if (!target || !day) return
    api<{ schedules: DoctorSchedule[] }>(`/api/schedule?date=${day}`)
      .then((d) => setSchedules(d.schedules))
      .catch((e) => toast.error((e as Error).message))
  }, [target, day])

  const doc = schedules.find((s) => s.id === doctorId)
  const free = (doc?.slots ?? []).filter((s) => s.status === 'FREE' && new Date(s.start).getTime() > Date.now())

  const submit = async () => {
    if (!target || !slot) return
    setSaving(true)
    try {
      await api(`/api/appointments/${target.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'RESCHEDULE', start: slot, doctorId }),
      })
      toast.success(`Запись перенесена на ${ddmmHHMM(new Date(slot))}, напоминания пересозданы`)
      onDone()
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Перенос записи</DialogTitle>
          <DialogDescription>
            {target?.patientName} · сейчас {target ? ddmmHHMM(new Date(target.start)) : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <Input type="date" value={day} min={todayKey()} onChange={(e) => { setDay(e.target.value); setSlot('') }} aria-label="Дата" className="sm:w-44 shrink-0" />
            <Select value={doctorId} onValueChange={(v) => { setDoctorId(v); setSlot('') }}>
              <SelectTrigger aria-label="Врач" className="w-full min-w-0 flex-1">
                <SelectValue placeholder="Врач" />
              </SelectTrigger>
              <SelectContent>
                {schedules.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} · {s.specialty}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto" role="listbox" aria-label="Свободные слоты">
            {free.length === 0 && <div className="text-sm text-slate-500">Свободных слотов нет — выберите другой день или врача.</div>}
            {free.map((s) => (
              <button
                key={s.start}
                role="option"
                aria-selected={slot === s.start}
                onClick={() => setSlot(s.start)}
                className={`rounded-md border px-2.5 py-1 text-sm ${slot === s.start ? 'bg-emerald-600 text-white border-emerald-600' : 'hover:bg-slate-50'}`}
              >
                {s.time}
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={!slot || saving} onClick={submit}>
            Перенести
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Подтверждение отмены записи (чеклист п.9)
export function ConfirmCancelDialog({ target, onCancel, onConfirm }: { target: { patientName: string; start: string } | null; onCancel: () => void; onConfirm: () => void }) {
  return (
    <AlertDialog open={target !== null} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Отменить запись?</AlertDialogTitle>
          <AlertDialogDescription>
            {target?.patientName} · {target ? ddmmHHMM(new Date(target.start)) : ''}. Слот освободится и будет предложен листу ожидания.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Не отменять</AlertDialogCancel>
          <AlertDialogAction className="bg-rose-600 hover:bg-rose-700" onClick={onConfirm}>
            Отменить запись
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
