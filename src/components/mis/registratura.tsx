// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import PatientSearch from './patient-search'
import PatientCardDialog from './patient-card-dialog'
import RisksPanel from './risks-panel'
import { api } from '@/lib/api'
import { Me, can } from '@/lib/rbac'
import { AppointmentDTO, DoctorSchedule, PatientLite, Slot, SOURCE_LABELS, STATUS_LABELS } from '@/lib/types'
import { dateKey, statusClass, timeStr } from '@/lib/mis-utils'
import { toast } from 'sonner'
import { ConfirmCancelDialog, RescheduleDialog, RescheduleTarget } from './reschedule-dialog'
import { CalendarPlus, Timer, X, Stethoscope, Zap, PhoneOff, UserCheck, ShieldAlert, CalendarClock } from 'lucide-react'

interface DoctorLite {
  id: string
  name: string
  specialty: string
}

interface Props {
  me: Me
  onOpenVisit: (appointmentId: string) => void
}

// Контур «Регистратура»: запись пациента ≤ 10 секунд (точка улучшения №1)
export default function Registratura({ me, onOpenVisit }: Props) {
  const canBook = can(me, 'appointments.create')
  const canUpdate = can(me, 'appointments.update')
  const canStartVisit = can(me, 'visits.write')
  const canManagePatient = can(me, 'patients.manage')
  const [cardOpen, setCardOpen] = useState(false)
  const [doctors, setDoctors] = useState<DoctorLite[]>([])
  const [rescheduleTarget, setRescheduleTarget] = useState<RescheduleTarget | null>(null)
  const [cancelTarget, setCancelTarget] = useState<AppointmentDTO | null>(null)
  const [schedules, setSchedules] = useState<DoctorSchedule[] | null>(null)
  const [patient, setPatient] = useState<PatientLite | null>(null)
  const [doctorId, setDoctorId] = useState<string>('')
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null)
  const [booking, setBooking] = useState(false)
  const [today, setToday] = useState<AppointmentDTO[]>([])

  // Таймер скорости записи
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [lastResult, setLastResult] = useState<number | null>(null)
  const [best, setBest] = useState<number | null>(null)
  const startedRef = useRef<number>(0)

  const todayParam = dateKey(new Date())

  const loadToday = useCallback(async () => {
    try {
      const data = await api<{ appointments: AppointmentDTO[] }>(`/api/appointments?date=${todayParam}`)
      setToday(data.appointments)
    } catch (e) {
      console.error(e)
    }
  }, [todayParam])

  useEffect(() => {
    api<{ doctors: DoctorLite[] }>('/api/doctors')
      .then((d) => setDoctors(d.doctors))
      .catch((e) => toast.error((e as Error).message))
    api<{ schedules: DoctorSchedule[] }>(`/api/schedule?date=${todayParam}`)
      .then((d) => setSchedules(d.schedules))
      .catch((e) => toast.error((e as Error).message))
    loadToday()
    // Легкий поллинг: записи из виджета (ФТ-012) появляются без перезагрузки
    const poll = setInterval(loadToday, 15000)
    const stored = Number(localStorage.getItem('medflow_best') || '0')
    setBest(stored > 0 ? stored : null)
    // Таймер стартует сразу — как только рег took звонок
    startedRef.current = Date.now()
    setRunning(true)
    return () => clearInterval(poll)
  }, [loadToday, todayParam])

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setElapsed((Date.now() - startedRef.current) / 1000), 100)
    return () => clearInterval(t)
  }, [running])

  useEffect(() => {
    if (!doctorId || !schedules) return
    const sch = schedules.find((s) => s.id === doctorId)
    if (!sch) return
    const nowMs = Date.now()
    const free = sch.slots.filter((s) => s.status === 'FREE' && new Date(s.start).getTime() > nowMs)
    setSelectedSlot(free[0] ?? null)
  }, [doctorId, schedules])

  const restartTimer = () => {
    startedRef.current = Date.now()
    setElapsed(0)
    setLastResult(null)
    setRunning(true)
  }

  const freeSlots = useMemo(() => {
    if (!doctorId || !schedules) return []
    const sch = schedules.find((s) => s.id === doctorId)
    if (!sch) return []
    const nowMs = Date.now()
    return sch.slots.filter((s) => s.status === 'FREE' && new Date(s.start).getTime() > nowMs)
  }, [doctorId, schedules])

  const book = async () => {
    if (!patient || !doctorId || !selectedSlot) {
      toast.error('Выберите пациента, врача и слот')
      return
    }
    setBooking(true)
    const doc = doctors.find((d) => d.id === doctorId)
    try {
      const res = await api<{ remindersCreated: number }>('/api/appointments', {
        method: 'POST',
        body: JSON.stringify({ patientId: patient.id, doctorId, start: selectedSlot.start, source: 'REGISTRAR' }),
      })
      const sec = running ? (Date.now() - startedRef.current) / 1000 : null
      if (sec !== null) {
        setRunning(false)
        setLastResult(sec)
        const stored = Number(localStorage.getItem('medflow_best') || '0')
        if (!stored || sec < stored) {
          localStorage.setItem('medflow_best', String(sec))
          setBest(sec)
        }
      }
      toast.success(
        `Записан: ${patient.lastName} — ${doc?.name}, ${selectedSlot.time}${sec !== null ? ` · запись за ${sec.toFixed(1)} с` : ''} · напоминания запланированы по правилам каскада`
      )
      setPatient(null)
      setDoctorId('')
      setSelectedSlot(null)
      await Promise.all([loadToday(), api<{ schedules: DoctorSchedule[] }>(`/api/schedule?date=${todayParam}`).then((d) => setSchedules(d.schedules))])
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBooking(false)
    }
  }

  const startVisit = async (a: AppointmentDTO) => {
    try {
      const data = await api<{ visit: { appointmentId: string } }>('/api/visits', {
        method: 'POST',
        body: JSON.stringify({ appointmentId: a.id }),
      })
      onOpenVisit(data.visit.appointmentId)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const setStatus = async (a: AppointmentDTO, status: string) => {
    try {
      const data = await api<{ waitingOffer: { patientName: string; notificationStatus: string } | null }>(`/api/appointments/${a.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      })
      toast.success(`${a.patientName}: ${STATUS_LABELS[status] || status}`)
      if (['CANCELED', 'NO_SHOW'].includes(status)) {
        if (data.waitingOffer) {
          const st = data.waitingOffer.notificationStatus
          const via =
            st === 'SENT'
              ? ' — приглашение отправлено через Центр уведомлений'
              : st === 'DEFERRED_QUIET'
                ? ' — приглашение отложено часами тишины (ФТ-013)'
                : st === 'QUEUED'
                  ? ' — приглашение в очереди центра'
                  : ''
          toast.info(
            `Слот ${timeStr(new Date(a.start))} предложен из листа ожидания: ${data.waitingOffer.patientName} — 15 минут на ответ${via}`
          )
        } else {
          toast.info('В листе ожидания нет подходящих пациентов на этот слот')
        }
      }
      loadToday()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const nearestTime = freeSlots[0]?.time

  if (!canBook) {
    return (
      <Card>
        <CardContent className="p-8 text-center space-y-2">
          <ShieldAlert className="h-8 w-8 text-amber-500 mx-auto" />
          <div className="text-sm text-slate-600">Создание записей недоступно вашей роли (RBAC: appointments.create). Просмотр «Сегодня в клинике» — в контуре расписания.</div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      <Card className="lg:col-span-3">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarPlus className="h-5 w-5 text-emerald-600" />
              Запись пациента
            </CardTitle>
            <div className="flex items-center gap-2">
              {best !== null && (
                <Badge variant="outline" className="text-amber-600 border-amber-300">
                  <Zap className="h-3 w-3 mr-1" /> рекорд {best.toFixed(1)} с
                </Badge>
              )}
              {lastResult !== null ? (
                <Badge className={lastResult <= 10 ? 'bg-emerald-600' : 'bg-amber-600'}>запись за {lastResult.toFixed(1)} с</Badge>
              ) : running ? (
                <Badge variant="outline" className="font-mono tabular-nums text-slate-600">
                  <Timer className="h-3 w-3 mr-1" /> {elapsed.toFixed(1)} с
                </Badge>
              ) : null}
            </div>
          </div>
          <p className="text-xs text-slate-500 pt-1">
            Цель — не более 10 секунд от начала до подтверждения записи. Таймер стартует при открытии экрана.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {patient ? (
            <div className="flex items-center justify-between rounded-lg border bg-emerald-50 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">
                  {patient.lastName} {patient.firstName}
                  {patient.middleName ? ` ${patient.middleName}` : ''}
                </div>
                <div className="text-xs text-slate-500">
                  {patient.phone} · карта {patient.cardNumber}
                  {patient.noShowCount > 0 ? ` · было неявок: ${patient.noShowCount}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {canManagePatient && (
                  <Button variant="outline" size="sm" onClick={() => setCardOpen(true)}>
                    Карточка
                  </Button>
                )}
                <Button variant="ghost" size="icon" onClick={() => setPatient(null)} aria-label="Сбросить пациента">
                  <X className="h-4 w-4" />
                </Button>
              </div>
              {canManagePatient && (
                <PatientCardDialog patientId={patient.id} open={cardOpen} onOpenChange={setCardOpen} onChanged={() => setPatient(null)} />
              )}
            </div>
          ) : (
            <PatientSearch onPick={(p) => setPatient(p)} />
          )}

          <div>
            <div className="text-sm font-medium mb-1.5">2. Врач</div>
            <Select value={doctorId} onValueChange={setDoctorId} disabled={!patient}>
              <SelectTrigger aria-label="Выбор врача">
                <SelectValue placeholder="Выберите врача" />
              </SelectTrigger>
              <SelectContent>
                {doctors.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name} — {d.specialty}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {doctorId && (
            <div>
              <div className="text-sm font-medium mb-1.5">
                3. Слот на сегодня <span className="text-xs text-slate-400">(свободных: {freeSlots.length}, ближайший — {nearestTime ?? 'нет'})</span>
              </div>
              {freeSlots.length === 0 ? (
                <div className="text-sm text-slate-500 rounded-lg border p-3 bg-slate-50">
                  На сегодня свободных слотов нет — выберите другого врача.
                </div>
              ) : (
                <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5 max-h-44 overflow-y-auto">
                  {freeSlots.map((s) => {
                    const isSel = selectedSlot?.start === s.start
                    const isNearest = s.time === nearestTime
                    return (
                      <button
                        key={s.start}
                        onClick={() => setSelectedSlot(s)}
                        className={`relative rounded-md border px-1 py-1.5 text-xs font-medium transition-colors ${
                          isSel
                            ? 'bg-emerald-600 text-white border-emerald-600'
                            : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                        }`}
                        aria-pressed={isSel}
                      >
                        {s.time}
                        {isNearest && !isSel && (
                          <span className="absolute -top-1.5 right-0.5 text-[8px] bg-amber-100 text-amber-700 rounded px-0.5">ближ.</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={book} disabled={booking || !patient || !doctorId || !selectedSlot} className="flex-1 bg-emerald-600 hover:bg-emerald-700">
              {booking ? 'Записываю...' : 'Записать пациента'}
            </Button>
            <Button variant="outline" onClick={restartTimer} title="Перезапустить таймер">
              <Timer className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Stethoscope className="h-5 w-5 text-emerald-600" />
            Сегодня в клинике
          </CardTitle>
          <p className="text-xs text-slate-500">Статусы обновляются сразу после действий. Записей: {today.length}</p>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
            {today.length === 0 && <div className="text-sm text-slate-500">Записей на сегодня нет.</div>}
            {today.map((a) => {
              const dt = new Date(a.start)
              return (
                <div key={a.id} className="rounded-lg border p-2.5 flex items-start justify-between gap-2 bg-white">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-mono text-sm font-medium">{timeStr(dt)}</span>
                      <span className="text-sm font-medium truncate">{a.patientName}</span>
                      <Badge className={`text-[10px] ${statusClass(a.status)}`}>{STATUS_LABELS[a.status]}</Badge>
                      <Badge variant="outline" className="text-[10px] text-slate-500">
                        {SOURCE_LABELS[a.source]}
                      </Badge>
                    </div>
                    <div className="text-xs text-slate-500 truncate">
                      {a.doctorName} · {a.doctorSpecialty}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    {['BOOKED', 'CONFIRMED', 'ARRIVED'].includes(a.status) && canStartVisit && (
                      <Button size="sm" variant="outline" className="h-7 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-50" onClick={() => startVisit(a)}>
                        <Stethoscope className="h-3 w-3 mr-1" /> Приём
                      </Button>
                    )}
                    {['BOOKED', 'CONFIRMED'].includes(a.status) && !canStartVisit && canUpdate && (
                      <Button size="sm" variant="outline" className="h-7 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-50" onClick={() => setStatus(a, 'ARRIVED')}>
                        <UserCheck className="h-3 w-3 mr-1" /> Пациент пришёл
                      </Button>
                    )}
                    {['BOOKED', 'CONFIRMED'].includes(a.status) && canUpdate && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" className="h-7 text-xs text-rose-600 border-rose-200 hover:bg-rose-50" onClick={() => setStatus(a, 'NO_SHOW')} title="Отметить неявку">
                          <PhoneOff className="h-3 w-3" />
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs text-slate-500" onClick={() => setRescheduleTarget({ id: a.id, patientName: a.patientName, doctorId: a.doctorId, start: a.start })} title="Перенести запись" aria-label={`Перенести: ${a.patientName}`}>
                          <CalendarClock className="h-3 w-3" />
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs text-slate-500" onClick={() => setCancelTarget(a)} title="Отменить запись" aria-label={`Отменить: ${a.patientName}`}>
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>
      </div>

      <RisksPanel me={me} onChanged={loadToday} />
      <RescheduleDialog target={rescheduleTarget} onClose={() => setRescheduleTarget(null)} onDone={loadToday} />
      <ConfirmCancelDialog
        target={cancelTarget}
        onCancel={() => setCancelTarget(null)}
        onConfirm={() => {
          if (cancelTarget) setStatus(cancelTarget, 'CANCELED')
          setCancelTarget(null)
        }}
      />
    </div>
  )
}
