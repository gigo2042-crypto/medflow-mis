// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import PatientSearch from './patient-search'
import { api } from '@/lib/api'
import { Me, can } from '@/lib/rbac'
import {
  DAY_LABELS,
  DoctorSchedule,
  PatientLite,
  ServiceDTO,
  Slot,
  WAITING_STATUS_LABELS,
  WaitingEntryDTO,
  WaitingStats,
} from '@/lib/types'
import { addDaysKey, clinicDayStart, dateKey, ddmm, minutesOf, pad2, timeStr, todayKey, zonedParts } from '@/lib/mis-utils'
import { toast } from 'sonner'
import { Hourglass, RefreshCw, UserPlus, Check, X, Flame, Trash2, CalendarCheck, ShieldAlert, ArrowRightCircle } from 'lucide-react'

interface DoctorLite {
  id: string
  name: string
  specialty: string
}

const TIME_OPTIONS: string[] = (() => {
  const arr: string[] = []
  for (let m = 8 * 60; m <= 20 * 60; m += 30) arr.push(`${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`)
  return arr
})()

function fmtSlot(iso: string): string {
  const d = new Date(iso)
  return `${ddmm(d)} в ${timeStr(d)}`
}

function fmtCountdown(msLeft: number): string {
  const s = Math.max(0, Math.floor(msLeft / 1000))
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`
}

function waitStatusClass(status: string): string {
  switch (status) {
    case 'OFFERED':
      return 'bg-amber-100 text-amber-700'
    case 'ACTIVE':
      return 'bg-emerald-100 text-emerald-700'
    case 'BOOKED':
      return 'bg-teal-100 text-teal-700'
    case 'DECLINED':
      return 'bg-rose-100 text-rose-700'
    default:
      return 'bg-slate-100 text-slate-500'
  }
}

function wishesOf(e: WaitingEntryDTO): string {
  const days = DAY_LABELS.filter((_, i) => e.daysMask[i] === '1')
  const target = e.doctorName ? `врач: ${e.doctorName}` : e.specialty ? `направление: ${e.specialty}` : 'любой врач'
  return `${target} · ${e.fromTime}–${e.toTime} · ${days.join('') || 'любой день'}${e.serviceName ? ` · услуга: ${e.serviceName}` : ''}`
}

// Лист ожидания (ФТ-004): очередь с приоритетами, автопредложение слотов при отмене
// и неявке, ограничение времени ответа 15 минут, конверсия в запись
export default function WaitingList({ me }: { me: Me }) {
  const canManage = can(me, 'waitinglist.manage')
  const [entries, setEntries] = useState<WaitingEntryDTO[]>([])
  const [stats, setStats] = useState<WaitingStats | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [doctors, setDoctors] = useState<DoctorLite[]>([])
  const [services, setServices] = useState<ServiceDTO[]>([])
  const [now, setNow] = useState(Date.now())

  const load = useCallback(async () => {
    try {
      const data = await api<{ entries: WaitingEntryDTO[]; stats: WaitingStats }>(
        `/api/waiting-list?status=${showAll ? 'all' : 'active'}`
      )
      setEntries(data.entries)
      setStats(data.stats)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [showAll])

  useEffect(() => {
    load()
    api<{ doctors: DoctorLite[] }>('/api/doctors')
      .then((d) => setDoctors(d.doctors))
      .catch(() => undefined)
    api<{ services: ServiceDTO[] }>('/api/services')
      .then((d) => setServices(d.services))
      .catch(() => undefined)
    const poll = setInterval(load, 5000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [load])

  // ---- Форма постановки в очередь ----
  const [patient, setPatient] = useState<PatientLite | null>(null)
  const [doctorChoice, setDoctorChoice] = useState('any')
  const [fromTime, setFromTime] = useState('08:00')
  const [toTime, setToTime] = useState('20:00')
  const [days, setDays] = useState<boolean[]>([true, true, true, true, true, false, false])
  const [serviceId, setServiceId] = useState('none')
  const [priority, setPriority] = useState('0')
  const [comment, setComment] = useState('')
  const [adding, setAdding] = useState(false)

  const specialtyOptions = useMemo(() => {
    const set = new Map<string, number>()
    doctors.forEach((d) => set.set(d.specialty, (set.get(d.specialty) || 0) + 1))
    return Array.from(set.entries())
  }, [doctors])

  const add = async () => {
    if (!patient) {
      toast.error('Выберите пациента')
      return
    }
    const mask = days.map((d) => (d ? '1' : '0')).join('')
    if (!mask.includes('1')) {
      toast.error('Выберите хотя бы один день недели')
      return
    }
    if (fromTime >= toTime) {
      toast.error('Окно времени: начало раньше конца')
      return
    }
    setAdding(true)
    try {
      const isSpec = doctorChoice.startsWith('spec:')
      await api('/api/waiting-list', {
        method: 'POST',
        body: JSON.stringify({
          patientId: patient.id,
          doctorId: !isSpec && doctorChoice !== 'any' ? doctorChoice : null,
          specialty: isSpec ? doctorChoice.slice(5) : null,
          serviceId: serviceId !== 'none' ? serviceId : null,
          daysMask: mask,
          fromTime,
          toTime,
          priority: Number(priority),
          comment: comment || null,
        }),
      })
      toast.success(`${patient.lastName} поставлен(а) в лист ожидания`)
      setPatient(null)
      setComment('')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  // ---- Диалог ручной рассадки ----
  const [bookingEntry, setBookingEntry] = useState<WaitingEntryDTO | null>(null)
  const [bookDoctorId, setBookDoctorId] = useState('')
  const [bookDayOffset, setBookDayOffset] = useState(0)
  const [bookSlots, setBookSlots] = useState<Slot[] | null>(null)
  const [bookStart, setBookStart] = useState<string | null>(null)
  const [booking, setBooking] = useState(false)

  const openBooking = (e: WaitingEntryDTO) => {
    setBookingEntry(e)
    setBookDoctorId(e.doctorId || '')
    setBookDayOffset(0)
    setBookStart(null)
    setBookSlots(null)
  }

  // номер последнего запроса слотов: ответ на устаревший запрос (другой день/врач) не применяется
  const bookReq = useRef(0)
  const loadBookSlots = useCallback(async (doctorId: string, dayOffset: number, entry: WaitingEntryDTO | null) => {
    if (!doctorId || !entry) return
    const req = ++bookReq.current
    const dKey = addDaysKey(todayKey(), dayOffset)
    const d = clinicDayStart(dayOffset)
    try {
      const data = await api<{ schedules: DoctorSchedule[] }>(`/api/schedule?date=${dKey}`)
      if (req !== bookReq.current) return
      const sch = data.schedules.find((s) => s.id === doctorId)
      if (!sch) {
        setBookSlots([])
        return
      }
      // Подбор по соответствию (ТУ-004): только слоты, подходящие пожеланиям заявки
      const dayIdx = zonedParts(d).weekday
      const dayOk = entry.daysMask[dayIdx] === '1'
      const matching = sch.slots.filter((s) => {
        if (s.status !== 'FREE' || new Date(s.start).getTime() <= Date.now()) return false
        if (!dayOk) return false
        const m = minutesOf(s.time)
        return m >= minutesOf(entry.fromTime) && m < minutesOf(entry.toTime)
      })
      setBookSlots(matching)
    } catch (err) {
      if (req !== bookReq.current) return
      toast.error((err as Error).message)
      setBookSlots([])
    }
  }, [])

  useEffect(() => {
    // смена дня/врача: слот, выбранный раньше, к новому списку не относится
    setBookStart(null)
    setBookSlots(null)
    if (bookingEntry) loadBookSlots(bookDoctorId || bookingEntry.doctorId || '', bookDayOffset, bookingEntry)
  }, [bookingEntry, bookDoctorId, bookDayOffset, loadBookSlots])

  const book = async () => {
    if (!bookingEntry || !bookStart) return
    setBooking(true)
    try {
      const res = await api<{ remindersCreated: number }>(`/api/waiting-list/${bookingEntry.id}/accept`, {
        method: 'POST',
        body: JSON.stringify({ start: bookStart, doctorId: bookDoctorId || bookingEntry.doctorId || undefined }),
      })
      toast.success(
        `${bookingEntry.patientName} записан(а) из листа ожидания · каскад напоминаний: ${res.remindersCreated}`
      )
      setBookingEntry(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBooking(false)
    }
  }

  const acceptOffer = async (e: WaitingEntryDTO) => {
    try {
      const res = await api<{ remindersCreated: number }>(`/api/waiting-list/${e.id}/accept`, { method: 'POST' })
      toast.success(`Слот закреплён за ${e.patientName} · напоминания: ${res.remindersCreated}`)
      load()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const declineOffer = async (e: WaitingEntryDTO) => {
    try {
      const res = await api<{ offeredTo: string | null }>(`/api/waiting-list/${e.id}/decline`, { method: 'POST' })
      toast.success(
        res.offeredTo
          ? `Отказ зафиксирован — слот предложен следующему: ${res.offeredTo}`
          : 'Отказ зафиксирован — подходящих пациентов в очереди нет'
      )
      load()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const removeEntry = async (e: WaitingEntryDTO) => {
    try {
      const res = await api<{ offeredTo: string | null }>(`/api/waiting-list/${e.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'CANCEL' }),
      })
      toast.success(
        res.offeredTo ? `Заявка снята — слот предложен: ${res.offeredTo}` : 'Заявка снята с очереди'
      )
      load()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      <Card className="lg:col-span-3">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="flex items-center gap-2 text-base">
              <Hourglass className="h-5 w-5 text-emerald-600" />
              Лист ожидания
            </CardTitle>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" onClick={load} title="Обновить">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant={showAll ? 'default' : 'ghost'} onClick={() => setShowAll((v) => !v)} className="text-xs">
                {showAll ? 'Вся история' : 'Только очередь'}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Badge className="bg-emerald-100 text-emerald-700">в очереди: {stats?.active ?? 0}</Badge>
            <Badge className="bg-amber-100 text-amber-700">предложен слот: {stats?.offered ?? 0}</Badge>
            <Badge className="bg-teal-100 text-teal-700">записано: {stats?.booked ?? 0}</Badge>
            <Badge variant="outline" className="text-slate-600">конверсия: {stats?.conversion ?? 0}%</Badge>
          </div>
          <p className="text-xs text-slate-500 pt-1">
            При отмене или неявке слот автоматически предлагается первому подходящему пациенту (врач/направление,
            окно времени, дни недели) — на ответ 15 минут. Цель по ТУ-004: ≥ 30% освободившихся слотов замещается из
            очереди.
          </p>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border max-h-[560px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">№</TableHead>
                  <TableHead>Пациент</TableHead>
                  <TableHead>Пожелания</TableHead>
                  <TableHead className="w-24">Статус</TableHead>
                  {canManage && <TableHead className="w-56">Действия</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={canManage ? 5 : 4} className="text-center text-sm text-slate-500 py-8">
                      {showAll ? 'История пуста' : 'Очередь пуста — поставьте первого пациента'}
                    </TableCell>
                  </TableRow>
                )}
                {entries.map((e) => {
                  const ttl = e.offerExpiresAt ? new Date(e.offerExpiresAt).getTime() - now : 0
                  return (
                    <TableRow key={e.id} className={e.status === 'OFFERED' ? 'bg-amber-50/60' : ''}>
                      <TableCell className="font-mono text-xs text-slate-500">{e.position ?? '—'}</TableCell>
                      <TableCell>
                        <div className="text-sm font-medium truncate">{e.patientName}</div>
                        <div className="text-xs text-slate-500">
                          {e.patientPhone} · {e.cardNumber}
                        </div>
                        {e.comment && <div className="text-xs text-slate-400 italic truncate">{e.comment}</div>}
                      </TableCell>
                      <TableCell>
                        <div className="text-xs text-slate-600 max-w-[220px]">{wishesOf(e)}</div>
                        {e.priority > 0 && (
                          <Badge className="mt-1 text-[10px] bg-rose-100 text-rose-700">
                            <Flame className="h-3 w-3 mr-0.5" /> срочно
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {e.status === 'OFFERED' ? (
                          <div className="space-y-1">
                            <Badge className={`text-[10px] ${waitStatusClass(e.status)}`}>
                              {WAITING_STATUS_LABELS[e.status]}
                            </Badge>
                            <div className="text-xs text-slate-600">
                              {e.offeredSlot && e.offeredDoctorName ? `${fmtSlot(e.offeredSlot)}, ${e.offeredDoctorName}` : ''}
                            </div>
                            <div className={`text-xs font-mono ${ttl < 120000 ? 'text-rose-600' : 'text-slate-500'}`}>
                              ответ: {fmtCountdown(ttl)}
                            </div>
                          </div>
                        ) : (
                          <Badge className={`text-[10px] ${waitStatusClass(e.status)}`}>
                            {WAITING_STATUS_LABELS[e.status]}
                          </Badge>
                        )}
                      </TableCell>
                      {canManage && (
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {e.status === 'OFFERED' && (
                              <>
                                <Button
                                  size="sm"
                                  className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700"
                                  onClick={() => acceptOffer(e)}
                                >
                                  <Check className="h-3 w-3 mr-1" /> Пациент согласен
                                </Button>
                                <Button size="sm" variant="outline" className="h-7 text-xs border-rose-200 text-rose-600 hover:bg-rose-50" onClick={() => declineOffer(e)}>
                                  <X className="h-3 w-3 mr-1" /> Отказ
                                </Button>
                              </>
                            )}
                            {e.status === 'ACTIVE' && (
                              <>
                                <Button size="sm" variant="outline" className="h-7 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-50" onClick={() => openBooking(e)}>
                                  <CalendarCheck className="h-3 w-3 mr-1" /> Записать
                                </Button>
                                <Button size="sm" variant="outline" className="h-7 text-xs text-slate-500" onClick={() => removeEntry(e)} title="Снять с очереди">
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-slate-400 pt-2 flex items-center gap-1">
            <ArrowRightCircle className="h-3.5 w-3.5" />
            Демо: отмените любую запись во вкладке «Регистратура» — верхняя подходящая заявка получит автопредложение
            слота.
          </p>
        </CardContent>
      </Card>

      {canManage && (
        <Card className="lg:col-span-2 h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <UserPlus className="h-5 w-5 text-emerald-600" />
              В лист ожидания
            </CardTitle>
            <p className="text-xs text-slate-500">Пациент хочет раньше, чем есть свободные слоты</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {patient ? (
              <div className="flex items-center justify-between rounded-lg border bg-emerald-50 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{patient.lastName} {patient.firstName}</div>
                  <div className="text-xs text-slate-500">{patient.phone} · карта {patient.cardNumber}</div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setPatient(null)} aria-label="Сбросить пациента">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <PatientSearch onPick={(p) => setPatient(p)} placeholder="Поиск: фамилия или телефон" />
            )}

            <div>
              <div className="text-sm font-medium mb-1.5">Врач или направление</div>
              <Select value={doctorChoice} onValueChange={setDoctorChoice} disabled={!patient}>
                <SelectTrigger aria-label="Врач или направление">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Любой врач</SelectItem>
                  {specialtyOptions.map(([spec, n]) => (
                    <SelectItem key={spec} value={`spec:${spec}`}>
                      {spec} ({n})
                    </SelectItem>
                  ))}
                  {doctors.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name} — {d.specialty}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {doctorChoice.startsWith('spec:') && (
                <div className="text-xs text-amber-600 pt-1">
                  Направление: {doctorChoice.replace('spec:', '')} — подойдёт любой врач профиля
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-sm font-medium mb-1.5">С, ч</div>
                <Select value={fromTime} onValueChange={setFromTime} disabled={!patient}>
                  <SelectTrigger aria-label="Окно от"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TIME_OPTIONS.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="text-sm font-medium mb-1.5">До, ч</div>
                <Select value={toTime} onValueChange={setToTime} disabled={!patient}>
                  <SelectTrigger aria-label="Окно до"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TIME_OPTIONS.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <div className="text-sm font-medium mb-1.5">Удобные дни</div>
              <div className="flex gap-1.5">
                {DAY_LABELS.map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDays((prev) => prev.map((v, idx) => (idx === i ? !v : v)))}
                    aria-pressed={days[i]}
                    className={`h-9 w-11 rounded-md border text-xs font-medium transition-colors ${
                      days[i]
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-sm font-medium mb-1.5">Услуга</div>
                <Select value={serviceId} onValueChange={setServiceId} disabled={!patient}>
                  <SelectTrigger aria-label="Услуга"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Не указана</SelectItem>
                    {services.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} · {s.price} ₽
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="text-sm font-medium mb-1.5">Приоритет</div>
                <Select value={priority} onValueChange={setPriority} disabled={!patient}>
                  <SelectTrigger aria-label="Приоритет"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Обычный</SelectItem>
                    <SelectItem value="1">Срочный</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <div className="text-sm font-medium mb-1.5">Комментарий</div>
              <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Например: острая боль" disabled={!patient} />
            </div>

            <Button
              onClick={add}
              disabled={adding || !patient}
              className="w-full bg-emerald-600 hover:bg-emerald-700"
            >
              {adding ? 'Ставлю в очередь...' : 'Поставить в очередь'}
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!bookingEntry} onOpenChange={(o) => !o && setBookingEntry(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Рассадка из листа ожидания</DialogTitle>
            <DialogDescription>
              {bookingEntry?.patientName} · показаны только слоты, подходящие пожеланиям
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <div className="text-sm font-medium mb-1.5">Врач</div>
              <Select value={bookDoctorId} onValueChange={setBookDoctorId}>
                <SelectTrigger aria-label="Врач для записи">
                  <SelectValue placeholder="Выберите врача" />
                </SelectTrigger>
                <SelectContent>
                  {doctors
                    .filter((d) => !bookingEntry?.specialty || d.specialty === bookingEntry.specialty)
                    .map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name} — {d.specialty}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="text-sm font-medium mb-1.5">День</div>
              <div className="flex gap-1.5">
                {[0, 1].map((off) => {
                  const d = clinicDayStart(off)
                  const label = off === 0 ? 'Сегодня' : `Завтра · ${ddmm(d)}`
                  const dayIdx = zonedParts(d).weekday
                  const allowed = bookingEntry ? bookingEntry.daysMask[dayIdx] === '1' : true
                  return (
                    <button
                      key={off}
                      type="button"
                      disabled={!allowed}
                      onClick={() => setBookDayOffset(off)}
                      className={`h-9 flex-1 rounded-md border text-xs font-medium transition-colors ${
                        bookDayOffset === off
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
            <div>
              <div className="text-sm font-medium mb-1.5">Слот</div>
              {bookSlots === null ? (
                <div className="text-xs text-slate-400">Загрузка слотов…</div>
              ) : bookSlots.length === 0 ? (
                <div className="text-xs text-slate-500 rounded-lg border p-3 bg-slate-50">
                  Подходящих слотов нет — окно времени или дни не совпадают. Попробуйте другой день/врача.
                </div>
              ) : (
                <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5 max-h-40 overflow-y-auto">
                  {bookSlots.map((s) => (
                    <button
                      key={s.start}
                      type="button"
                      onClick={() => setBookStart(s.start)}
                      aria-pressed={bookStart === s.start}
                      className={`rounded-md border px-1 py-1.5 text-xs font-medium transition-colors ${
                        bookStart === s.start
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                      }`}
                    >
                      {s.time}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button
              onClick={book}
              disabled={booking || !bookStart || (!bookDoctorId && !bookingEntry?.doctorId)}
              className="w-full bg-emerald-600 hover:bg-emerald-700"
            >
              {booking ? 'Записываю...' : 'Записать на выбранный слот'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {!canManage && (
        <Card className="lg:col-span-2 h-fit">
          <CardContent className="p-6 text-sm text-slate-600 flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
            <div>
              Вашей роли доступен только просмотр очереди (RBAC: waitinglist.read). Управление заявками — у
              регистратуры и администратора (waitinglist.manage).
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
