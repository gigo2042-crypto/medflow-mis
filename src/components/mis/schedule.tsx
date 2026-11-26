// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import PatientSearch from './patient-search'
import ScheduleSettingsDialog from './schedule-settings-dialog'
import { api } from '@/lib/api'
import { Me, can } from '@/lib/rbac'
import { AppointmentDTO, DoctorSchedule, PatientLite, Slot, SOURCE_LABELS, STATUS_LABELS } from '@/lib/types'
import { addDaysKey, dateKey, longDayLabel, pad2, statusClass } from '@/lib/mis-utils'
import { toast } from 'sonner'
import { ConfirmCancelDialog, RescheduleDialog, RescheduleTarget } from './reschedule-dialog'
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react'

interface Props {
  me: Me
  onOpenVisit: (appointmentId: string) => void
}

const DOT_COLORS: Record<string, string> = {
  emerald: 'bg-emerald-500',
  teal: 'bg-teal-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
}

function slotBookedClass(status?: string): string {
  switch (status) {
    case 'DONE':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200'
    case 'ARRIVED':
      return 'bg-amber-100 text-amber-800 border-amber-200'
    case 'CONFIRMED':
      return 'bg-teal-100 text-teal-800 border-teal-200'
    case 'NO_SHOW':
      return 'bg-rose-100 text-rose-700 border-rose-200'
    default:
      return 'bg-slate-200 text-slate-700 border-slate-300'
  }
}

// Live-расписание со слотами; двойная бронь блокируется на уровне БД (точка улучшения №6)
export default function ScheduleView({ me, onOpenVisit }: Props) {
  const canBook = can(me, 'appointments.create')
  const canUpdate = can(me, 'appointments.update')
  const canStartVisit = can(me, 'visits.write')
  const canSettings = can(me, 'settings.manage')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dateStr, setDateStr] = useState<string>(dateKey(new Date()))
  const [schedules, setSchedules] = useState<DoctorSchedule[]>([])
  const [loading, setLoading] = useState(true)
  const [bookSlot, setBookSlot] = useState<{ slot: Slot; doctorId: string; doctorName: string } | null>(null)
  const [bookPatient, setBookPatient] = useState<PatientLite | null>(null)
  const [bookSource, setBookSource] = useState('REGISTRAR')
  const [booking, setBooking] = useState(false)
  const [manageSlot, setManageSlot] = useState<{ slot: Slot; doctorName: string; doctorId: string } | null>(null)
  const [rescheduleTarget, setRescheduleTarget] = useState<RescheduleTarget | null>(null)
  const [cancelTarget, setCancelTarget] = useState<{ id: string; patientName: string; start: string } | null>(null)

  const load = useCallback(async (d: string) => {
    setLoading(true)
    try {
      const data = await api<{ schedules: DoctorSchedule[] }>(`/api/schedule?date=${d}`)
      setSchedules(data.schedules)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(dateStr)
  }, [dateStr, load])

  const shiftDate = (days: number) => {
    setDateStr(addDaysKey(dateStr, days))
  }

  const dateLabel = (() => {
    return longDayLabel(dateStr)
  })()

  const openBook = (slot: Slot, doc: DoctorSchedule) => {
    if (!canBook) {
      toast.error('Запись недоступна вашей роли (RBAC: appointments.create)')
      return
    }
    setBookPatient(null)
    setBookSource('REGISTRAR')
    setBookSlot({ slot, doctorId: doc.id, doctorName: `${doc.name} — ${doc.specialty}` })
  }

  const book = async () => {
    if (!bookSlot || !bookPatient) return
    setBooking(true)
    try {
      await api('/api/appointments', {
        method: 'POST',
        body: JSON.stringify({ patientId: bookPatient.id, doctorId: bookSlot.doctorId, start: bookSlot.slot.start, source: bookSource }),
      })
      toast.success(`Записан ${bookPatient.lastName} на ${bookSlot.slot.time}`)
      setBookSlot(null)
      load(dateStr)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBooking(false)
    }
  }

  const apptAction = async (appointmentId: string, status: string) => {
    try {
      await api(`/api/appointments/${appointmentId}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      toast.success(`Статус: ${STATUS_LABELS[status] || status}`)
      setManageSlot(null)
      load(dateStr)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const startVisitFromSlot = async (slot: Slot) => {
    if (!slot.appointmentId) return
    try {
      await api('/api/visits', { method: 'POST', body: JSON.stringify({ appointmentId: slot.appointmentId }) })
      onOpenVisit(slot.appointmentId)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const isToday = dateStr === dateKey(new Date())

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => shiftDate(-1)} aria-label="Предыдущий день">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant={isToday ? 'default' : 'outline'} size="sm" onClick={() => setDateStr(dateKey(new Date()))} className={isToday ? 'bg-emerald-600 hover:bg-emerald-700' : ''}>
            Сегодня
          </Button>
          <Button variant="outline" size="icon" onClick={() => shiftDate(1)} aria-label="Следующий день">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium capitalize text-slate-700">{dateLabel}</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-slate-600">
            Двойная бронь блокируется автоматически
          </Badge>
          {canSettings && (
            <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
              <CalendarDays className="h-4 w-4 mr-1" /> График
            </Button>
          )}
        </div>
        {canSettings && <ScheduleSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} onChanged={() => load(dateStr)} />}
      </div>

      {loading ? (
        <div className="text-sm text-slate-500 p-6">Загрузка расписания...</div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {schedules.map((doc) => (
            <Card key={doc.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <span className={`h-2.5 w-2.5 rounded-full ${DOT_COLORS[doc.color] || 'bg-slate-400'}`} />
                  <span className="truncate">{doc.name}</span>
                  <span className="text-xs font-normal text-slate-500 truncate">· {doc.specialty} · {doc.workStart}-{doc.workEnd}</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {doc.dayOff && (
                  <div className="text-xs text-slate-500 mb-2">Нерабочий день: {doc.dayOff}{doc.slots.length ? ' · есть записи, которые нужно перенести' : ''}</div>
                )}
                <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-1">
                  {doc.slots.map((s) => {
                    const base = 'rounded-md border px-0.5 py-1 text-[11px] leading-tight transition-colors min-h-9 flex flex-col items-center justify-center'
                    if (s.status === 'BOOKED') {
                      return (
                        <button
                          key={s.start}
                          className={`${base} ${slotBookedClass(s.apptStatus)} hover:ring-1 hover:ring-slate-400`}
                          onClick={() => setManageSlot({ slot: s, doctorName: doc.name, doctorId: doc.id })}
                          title={`${s.time} · ${s.patientName} · ${s.apptStatus ? STATUS_LABELS[s.apptStatus] : ''}`}
                        >
                          <span className="font-mono font-medium">{s.time}</span>
                          <span className="truncate max-w-full px-0.5">{s.patientName?.split(' ')[0]}</span>
                        </button>
                      )
                    }
                    if (s.status === 'PAST') {
                      return (
                        <div key={s.start} className={`${base} bg-slate-50 text-slate-300 border-slate-100`} title="Прошедший слот">
                          <span className="font-mono">{s.time}</span>
                        </div>
                      )
                    }
                    return (
                      <button
                        key={s.start}
                        className={`${base} border-emerald-200 text-emerald-700 hover:bg-emerald-50`}
                        onClick={() => openBook(s, doc)}
                        title={`Свободно: ${s.time}. Нажмите, чтобы записать пациента`}
                      >
                        <span className="font-mono font-medium">{s.time}</span>
                        <Plus className="h-3 w-3 opacity-50" />
                      </button>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Диалог записи в свободный слот */}
      <Dialog open={!!bookSlot} onOpenChange={(o) => !o && setBookSlot(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Запись на приём</DialogTitle>
            <DialogDescription>
              {bookSlot?.doctorName} · {bookSlot ? `${bookSlot.slot.time}-${bookSlot.slot.end}` : ''}
            </DialogDescription>
          </DialogHeader>
          <PatientSearch onPick={setBookPatient} placeholder="Найдите пациента" />
          <div>
            <div className="text-sm font-medium mb-1">Источник записи</div>
            <Select value={bookSource} onValueChange={setBookSource}>
              <SelectTrigger aria-label="Источник записи">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBookSlot(null)}>
              Отмена
            </Button>
            <Button onClick={book} disabled={!bookPatient || booking} className="bg-emerald-600 hover:bg-emerald-700">
              {booking ? 'Записываю...' : 'Записать'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Диалог управления занятым слотом */}
      <Dialog open={!!manageSlot} onOpenChange={(o) => !o && setManageSlot(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Занятый слот</DialogTitle>
            <DialogDescription>
              {manageSlot?.slot.time} · {manageSlot?.slot.patientName} · {manageSlot?.doctorName}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Badge className={statusClass(manageSlot?.slot.apptStatus || '')}>
              {manageSlot?.slot.apptStatus ? STATUS_LABELS[manageSlot.slot.apptStatus] : ''}
            </Badge>
            <Badge variant="outline" className="text-slate-500">
              {manageSlot?.slot.source ? SOURCE_LABELS[manageSlot.slot.source] : ''}
            </Badge>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {['BOOKED', 'CONFIRMED'].includes(manageSlot?.slot.apptStatus || '') && canUpdate && (
              <Button variant="outline" onClick={() => apptAction(manageSlot!.slot.appointmentId!, 'CONFIRMED')}>
                Подтвердить
              </Button>
            )}
            {['BOOKED', 'CONFIRMED', 'ARRIVED'].includes(manageSlot?.slot.apptStatus || '') && canStartVisit && (
              <Button onClick={() => startVisitFromSlot(manageSlot!.slot)} className="bg-emerald-600 hover:bg-emerald-700">
                <CalendarDays className="h-4 w-4 mr-1" /> Начать приём
              </Button>
            )}
            {['BOOKED', 'CONFIRMED'].includes(manageSlot?.slot.apptStatus || '') && canUpdate && (
              <Button variant="outline" className="text-rose-600 border-rose-200 hover:bg-rose-50" onClick={() => apptAction(manageSlot!.slot.appointmentId!, 'NO_SHOW')}>
                Неявка
              </Button>
            )}
            {['BOOKED', 'CONFIRMED'].includes(manageSlot?.slot.apptStatus || '') && canUpdate && (
              <Button
                variant="outline"
                onClick={() => {
                  setRescheduleTarget({ id: manageSlot!.slot.appointmentId!, patientName: manageSlot!.slot.patientName || '', doctorId: manageSlot!.doctorId, start: manageSlot!.slot.start })
                  setManageSlot(null)
                }}
              >
                Перенести
              </Button>
            )}
            {['BOOKED', 'CONFIRMED'].includes(manageSlot?.slot.apptStatus || '') && canUpdate && (
              <Button variant="outline" onClick={() => setCancelTarget({ id: manageSlot!.slot.appointmentId!, patientName: manageSlot!.slot.patientName || '', start: manageSlot!.slot.start })}>
                Отменить запись
              </Button>
            )}
            {manageSlot?.slot.apptStatus === 'DONE' && (
              <Button variant="outline" onClick={() => onOpenVisit(manageSlot!.slot.appointmentId!)}>
                Открыть протокол
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <RescheduleDialog target={rescheduleTarget} onClose={() => setRescheduleTarget(null)} onDone={() => load(dateStr)} />
      <ConfirmCancelDialog
        target={cancelTarget}
        onCancel={() => setCancelTarget(null)}
        onConfirm={() => {
          if (cancelTarget) apptAction(cancelTarget.id, 'CANCELED')
          setCancelTarget(null)
        }}
      />
    </div>
  )
}
