// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { api } from '@/lib/api'
import { Me, can } from '@/lib/rbac'
import { AppointmentDTO, ProtocolTemplateDTO, ServiceDTO, SOURCE_LABELS, STATUS_LABELS } from '@/lib/types'
import { ageFromBirthDate, statusClass, timeStr, todayKey } from '@/lib/mis-utils'
import PrintFrame from '@/components/mis/print-frame'
import { buildProtocolPrint as renderProtocolPrint } from '@/lib/protocol-print'
import { usePublicConfig } from '@/lib/use-public-config'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from 'sonner'
import { Loader2, Save, Sparkles, Stethoscope, Timer, Bot, Printer, ShieldAlert, FlaskConical } from 'lucide-react'

interface VisitFull {
  id: string
  appointmentId: string
  patientId: string
  doctorId: string
  templateId: string | null
  complaints: string | null
  diagnosisCode: string | null
  diagnosisName: string | null
  protocolText: string | null
  templateData: string | null
  aiUsed: boolean
  serviceId: string | null
  price: number
  patient: {
    id: string
    cardNumber: string
    lastName: string
    firstName: string
    middleName: string | null
    phone: string
    gender: string
    birthDate: string | null
    notes: string | null
  }
  doctor: { id: string; name: string; specialty: string }
  appointment: { id: string; status: string; start: string }
}

interface Props {
  me: Me
  focusAppointmentId: string | null
}

const LAB_TESTS = [
  { code: '01-023', name: 'Общий анализ крови' },
  { code: '02-001', name: 'Глюкоза' },
  { code: 'A-11', name: 'ТТГ' },
  { code: 'A-12', name: 'Т4 свободный' },
  { code: 'B-101', name: 'Витамин D, 25-OH' },
]

// Контур «Работа врача»: ЭМК с интерактивным шаблоном и AI-черновиком (точки улучшения №2 и №3)
export default function Emk({ me, focusAppointmentId }: Props) {
  const canWrite = can(me, 'visits.write') // редактирование протокола — только врач/админ
  const canAiProtocol = can(me, 'ai.protocol')
  const canAiSummary = can(me, 'ai.summary')
  const [appointments, setAppointments] = useState<AppointmentDTO[]>([])
  const [templates, setTemplates] = useState<ProtocolTemplateDTO[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [visit, setVisit] = useState<VisitFull | null>(null)
  const [templateId, setTemplateId] = useState<string>('')
  const [complaints, setComplaints] = useState('')
  const [chips, setChips] = useState<Record<string, string[]>>({})
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [protocolText, setProtocolText] = useState('')
  const [diagnosisCode, setDiagnosisCode] = useState('')
  const [diagnosisName, setDiagnosisName] = useState('')
  const [icdQuery, setIcdQuery] = useState('')
  const [aiUsed, setAiUsed] = useState(false)
  const [complete, setComplete] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  // Превью текста для ИИ: врач видит ровно то, что уйдёт в модель, и подтверждает отправку
  type AiPreview = { kind: 'protocol' | 'summary'; preview: string; previewHash: string; target: { provider: string; external: boolean }; changed?: boolean }
  const [aiPreview, setAiPreview] = useState<AiPreview | null>(null)
  const [saving, setSaving] = useState(false)
  const [printDoc, setPrintDoc] = useState<string | null>(null)
  const [services, setServices] = useState<ServiceDTO[]>([])
  const [serviceId, setServiceId] = useState<string>('')
  // Лабораторное направление из ЭМК (чеклист п.11)
  const canLab = can(me, 'labs.create')
  const [labOpen, setLabOpen] = useState(false)
  const [lab, setLab] = useState('INVITRO')
  const [labTests, setLabTests] = useState<string[]>([])
  const [labSaving, setLabSaving] = useState(false)

  // Таймер протокола: цель ≤ 20 секунд (точка улучшения №2)
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [savedResult, setSavedResult] = useState<number | null>(null)
  const startedRef = useRef<number>(0)

  const cfg = usePublicConfig()
  const todayParam = todayKey()

  const loadAppointments = useCallback(async () => {
    try {
      const data = await api<{ appointments: AppointmentDTO[] }>(`/api/appointments?date=${todayParam}`)
      setAppointments(data.appointments)
    } catch (e) {
      console.error(e)
    }
  }, [todayParam])

  useEffect(() => {
    loadAppointments()
    api<{ templates: ProtocolTemplateDTO[] }>('/api/templates')
      .then((d) => setTemplates(d.templates))
      .catch((e) => toast.error((e as Error).message))
    api<{ services: ServiceDTO[] }>('/api/services')
      .then((d) => setServices(d.services.filter((x) => x.active)))
      .catch(() => setServices([]))
  }, [loadAppointments])

  const loadVisit = async (appointmentId: string) => {
    try {
      const data = await api<{ visit: VisitFull | null; visits?: VisitFull[] }>(`/api/visits?appointmentId=${appointmentId}`)
      const v = data.visit || (data.visits && data.visits[0]) || null
      if (v) {
        applyVisit(v)
      } else {
        setVisit(null)
        setSelectedId(appointmentId)
        resetForm()
      }
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const resetForm = () => {
    setComplaints('')
    setChips({})
    setTexts({})
    setProtocolText('')
    setDiagnosisCode('')
    setDiagnosisName('')
    setIcdQuery('')
    setAiUsed(false)
    setServiceId('')
    setComplete(false)
    setSummary(null)
    setSavedResult(null)
  }

  const applyVisit = (v: VisitFull) => {
    setVisit(v)
    setSelectedId(v.appointmentId)
    setComplaints(v.complaints || '')
    setDiagnosisCode(v.diagnosisCode || '')
    setDiagnosisName(v.diagnosisName || '')
    setProtocolText(v.protocolText || '')
    setAiUsed(v.aiUsed)
    setServiceId(v.serviceId || '')
    setComplete(v.appointment.status === 'DONE')
    setSavedResult(null)
    setSummary(null)
    // авто-выбор шаблона по специальности врача (точка улучшения №2)
    const dental = v.doctor.specialty.toLowerCase().includes('стоматолог')
    const preferred = templates.find((t) => (dental ? t.specialty === 'Стоматология' : t.specialty === 'Терапия'))
    setTemplateId(v.templateId || preferred?.id || templates[0]?.id || '')
    startedRef.current = Date.now()
    setElapsed(0)
    setRunning(true)
  }

  // фокус извне (из Регистратуры или Расписания)
  useEffect(() => {
    if (focusAppointmentId) {
      loadVisit(focusAppointmentId)
    }
  }, [focusAppointmentId])

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setElapsed((Date.now() - startedRef.current) / 1000), 100)
    return () => clearInterval(t)
  }, [running])

  const startVisit = async (a: AppointmentDTO) => {
    try {
      await api('/api/visits', { method: 'POST', body: JSON.stringify({ appointmentId: a.id }) })
      await loadVisit(a.id)
      loadAppointments()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const toggleChip = (key: string, option: string) => {
    setChips((prev) => {
      const arr = prev[key] || []
      const next = arr.includes(option) ? arr.filter((x) => x !== option) : [...arr, option]
      return { ...prev, [key]: next }
    })
  }

  const activeTemplate = templates.find((t) => t.id === templateId)

  const selectionsBySection = (): Record<string, string[]> => {
    const out: Record<string, string[]> = {}
    if (!activeTemplate) return out
    for (const section of activeTemplate.sections) {
      const vals: string[] = []
      for (const item of section.items) {
        const key = `${section.title}||${item.key}`
        vals.push(...(chips[key] || []))
      }
      if (vals.length) out[section.title] = vals
    }
    return out
  }

  const aiDraft = async (opts: { confirmHash?: string; localOnly?: boolean } = {}) => {
    if (!visit) return
    setAiLoading(true)
    try {
      const notes = activeTemplate
        ? activeTemplate.sections
            .flatMap((s) => s.items.filter((i) => i.type === 'text').map((i) => texts[`${s.title}||${i.key}`]).filter(Boolean))
            .join('; ')
        : ''
      const data = await api<{ protocol: string; ai: boolean } & Partial<Omit<AiPreview, 'kind'>> & { needConfirm?: boolean }>('/api/ai/protocol', {
        method: 'POST',
        body: JSON.stringify({
          ...opts,
          visitId: visit.id, // ФИО на сервере вычищаются из текста, в модель не уходят
          specialty: visit.doctor.specialty,
          diagnosisCode: diagnosisCode || null,
          complaints,
          selections: selectionsBySection(),
          notes,
          templateName: activeTemplate?.name || '',
        }),
      })
      if (data.needConfirm && data.preview && data.previewHash && data.target) {
        setAiPreview({ kind: 'protocol', preview: data.preview, previewHash: data.previewHash, target: data.target, changed: data.changed })
        return
      }
      setProtocolText(data.protocol)
      setAiUsed(true)
      toast.success(data.ai ? 'AI-черновик готов — проверьте и дополните' : 'Черновик собран по шаблону (LLM недоступен)')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAiLoading(false)
    }
  }

  const aiSummary = async (opts: { confirmHash?: string; localOnly?: boolean } = {}) => {
    if (!visit) return
    setSummaryLoading(true)
    try {
      const data = await api<{ summary: string; ai: boolean } & Partial<Omit<AiPreview, 'kind'>> & { needConfirm?: boolean }>('/api/ai/summary', {
        method: 'POST',
        body: JSON.stringify({ ...opts, patientId: visit.patient.id }),
      })
      if (data.needConfirm && data.preview && data.previewHash && data.target) {
        setAiPreview({ kind: 'summary', preview: data.preview, previewHash: data.previewHash, target: data.target, changed: data.changed })
        return
      }
      setSummary(data.summary)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSummaryLoading(false)
    }
  }

  const [icdSuggestions, setIcdSuggestions] = useState<Array<{ code: string; name: string }>>([])
  useEffect(() => {
    const q = icdQuery.trim()
    if (!q) {
      setIcdSuggestions([])
      return
    }
    const t = setTimeout(() => {
      api<{ items: Array<{ code: string; name: string }> }>(`/api/icd?q=${encodeURIComponent(q)}`)
        .then((r) => setIcdSuggestions(r.items))
        .catch(() => setIcdSuggestions([]))
    }, 250)
    return () => clearTimeout(t)
  }, [icdQuery])

  // Печатная форма протокола (ФТ-056): шапка + данные шаблона + текст
  const buildProtocolPrint = (): string => {
    if (!visit) return ''
    const tpl = templates.find((t) => t.id === (visit.templateId || templateId)) ?? activeTemplate
    return renderProtocolPrint(visit, tpl, {
      clinicLine: cfg?.clinic.configured ? `${cfg.clinic.name}, ИНН ${cfg.clinic.inn}, лицензия ${cfg.clinic.license}` : '',
      ageLine: ageFromBirthDate(visit.patient.birthDate),
    })
  }

  const createReferral = async () => {
    if (!visit || labTests.length === 0) return
    setLabSaving(true)
    try {
      const tests = LAB_TESTS.filter((t) => labTests.includes(t.code))
      await api('/api/integrations', {
        method: 'POST',
        body: JSON.stringify({ action: 'CREATE_REFERRAL', patientId: visit.patient.id, visitId: visit.id, lab, tests }),
      })
      toast.success('Направление в лабораторию создано')
      setLabOpen(false)
      setLabTests([])
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLabSaving(false)
    }
  }

  const save = async () => {
    if (!visit) return
    setSaving(true)
    try {
      await api(`/api/visits/${visit.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          complaints,
          diagnosisCode,
          diagnosisName,
          protocolText,
          templateId: templateId || undefined,
          templateData: JSON.stringify({ chips, texts }),
          aiUsed,
          serviceId: serviceId || null,
          complete,
        }),
      })
      const sec = running ? (Date.now() - startedRef.current) / 1000 : null
      setRunning(false)
      await loadVisit(visit.appointmentId)
      if (sec !== null) setSavedResult(sec)
      toast.success(complete ? 'Протокол сохранён, приём завершён' : 'Протокол сохранён')
      loadAppointments()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const editable = canWrite && visit?.appointment.status !== 'DONE' && (me.role !== 'DOCTOR' || visit?.doctorId === me.doctorId)
  const waiting = appointments.filter((a) => ['ARRIVED', 'BOOKED', 'CONFIRMED'].includes(a.status))
  const finishedToday = appointments.filter((a) => ['DONE', 'CANCELED', 'NO_SHOW'].includes(a.status))

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Stethoscope className="h-4 w-4 text-emerald-600" /> Приёмы сегодня
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 max-h-[560px] overflow-y-auto">
          {waiting.length === 0 && finishedToday.length === 0 && <div className="text-sm text-slate-500">Нет приёмов на сегодня.</div>}
          {waiting.map((a) => (
            <AppointmentRow key={a.id} a={a} selected={selectedId === a.id} onSelect={() => loadVisit(a.id)} />
          ))}
          {waiting.length > 0 && finishedToday.length > 0 && <div className="text-xs text-slate-400 pt-2 pl-1">Завершённые</div>}
          {finishedToday.map((a) => (
            <AppointmentRow key={a.id} a={a} selected={selectedId === a.id} onSelect={() => loadVisit(a.id)} />
          ))}
        </CardContent>
      </Card>

      <div className="space-y-4">
        {!selectedId && (
          <Card>
            <CardContent className="p-8 text-center text-sm text-slate-500">
              Выберите приём слева — или начните приём из Регистратуры / Расписания.
            </CardContent>
          </Card>
        )}

        {selectedId && !visit && (
          <Card>
            <CardContent className="p-6 space-y-3">
              <div className="text-sm text-slate-500">Приём выбран. Начните его, чтобы создать визит и ЭМК.</div>
              {editable ? (
                <Button onClick={() => startVisit(appointments.find((a) => a.id === selectedId)!)} className="bg-emerald-600 hover:bg-emerald-700">
                  <Stethoscope className="h-4 w-4 mr-1" /> Начать приём
                </Button>
              ) : (
                <div className="text-xs text-slate-500 flex items-center gap-1.5">
                  <ShieldAlert className="h-3.5 w-3.5 text-amber-500" /> Начало приёма доступно врачу (RBAC: visits.write)
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {visit && (
          <>
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <CardTitle className="text-base">
                      {visit.patient.lastName} {visit.patient.firstName}
                      {visit.patient.middleName ? ` ${visit.patient.middleName}` : ''}
                    </CardTitle>
                    <div className="text-xs text-slate-500">
                      карта {visit.patient.cardNumber} · {visit.patient.phone} · {ageFromBirthDate(visit.patient.birthDate)} · {visit.doctor.name} ({visit.doctor.specialty})
                    </div>
                    {visit.patient.notes && <div className="text-xs text-amber-700 mt-0.5">Важно: {visit.patient.notes}</div>}
                  </div>
                  <div className="flex items-center gap-2">
                    {savedResult !== null && (
                      <Badge className={savedResult <= 20 ? 'bg-emerald-600' : 'bg-amber-600'}>
                        протокол за {savedResult.toFixed(1)} с
                      </Badge>
                    )}
                    {running && savedResult === null && (
                      <Badge variant="outline" className="font-mono tabular-nums text-slate-600">
                        <Timer className="h-3 w-3 mr-1" /> {elapsed.toFixed(1)} с
                      </Badge>
                    )}
                    <Badge className={statusClass(visit.appointment.status)}>{STATUS_LABELS[visit.appointment.status]}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {canAiSummary && (
                    <Button variant="outline" size="sm" onClick={() => aiSummary()} disabled={summaryLoading} className="border-emerald-300 text-emerald-700 hover:bg-emerald-50">
                      {summaryLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
                      AI-резюме истории
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setPrintDoc(buildProtocolPrint())} disabled={!visit.protocolText || !cfg?.clinic.configured} title={cfg && !cfg.clinic.configured ? 'Реквизиты клиники не заданы (CLINIC_*) — печать недоступна' : undefined}>
                    <Printer className="h-4 w-4 mr-1" /> Печать протокола
                  </Button>
                  {canLab && (
                    <Button variant="outline" size="sm" onClick={() => setLabOpen(true)}>
                      <FlaskConical className="h-4 w-4 mr-1" /> Направление в лабораторию
                    </Button>
                  )}
                  <span className="text-xs text-slate-400 self-center">цель протокола — не более 20 секунд</span>
                </div>
                {summary && (
                  <Alert className="border-emerald-200 bg-emerald-50">
                    <Bot className="h-4 w-4 text-emerald-700" />
                    <AlertTitle className="text-sm">AI-резюме пациента</AlertTitle>
                    <AlertDescription className="text-sm text-slate-700">{summary}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <CardTitle className="text-sm">{editable ? 'Интерактивный шаблон протокола' : 'Шаблон протокола (только просмотр)'}</CardTitle>
                  {editable && (
                  <Select value={templateId} onValueChange={setTemplateId}>
                    <SelectTrigger className="w-[280px] h-8 text-xs" aria-label="Выбор шаблона">
                      <SelectValue placeholder="Шаблон" />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {!editable && (
                  <Alert className="border-amber-200 bg-amber-50">
                    <ShieldAlert className="h-4 w-4 text-amber-600" />
                    <AlertTitle className="text-sm">Режим только для чтения</AlertTitle>
                    <AlertDescription className="text-xs text-slate-600">
                      Редактирование протокола доступно врачу и администратору (RBAC: visits.write). Ваша роль — просмотр ЭМК и AI-резюме.
                    </AlertDescription>
                  </Alert>
                )}
                {editable && activeTemplate?.sections.map((section) => (
                  <div key={section.title}>
                    <div className="text-sm font-medium mb-1.5">{section.title}</div>
                    <div className="space-y-2">
                      {section.items.map((item) => {
                        const key = `${section.title}||${item.key}`
                        if (item.type === 'text') {
                          return (
                            <Input
                              key={key}
                              value={texts[key] || ''}
                              onChange={(e) => setTexts((prev) => ({ ...prev, [key]: e.target.value }))}
                              placeholder={item.placeholder || item.label}
                              className="h-9"
                            />
                          )
                        }
                        return (
                          <div key={key}>
                            <div className="text-xs text-slate-500 mb-1">{item.label}</div>
                            <div className="flex flex-wrap gap-1.5">
                              {(item.options || []).map((opt) => {
                                const on = (chips[key] || []).includes(opt)
                                return (
                                  <button
                                    key={opt}
                                    onClick={() => toggleChip(key, opt)}
                                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                                      on ? 'bg-emerald-600 text-white border-emerald-600' : 'border-slate-300 text-slate-600 hover:bg-emerald-50 hover:border-emerald-300'
                                    }`}
                                    aria-pressed={on}
                                  >
                                    {opt}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}

                {editable && (
                  <div>
                    <div className="text-sm font-medium mb-1">Тезисы врача (жалобы)</div>
                    <Textarea value={complaints} onChange={(e) => setComplaints(e.target.value)} rows={2} placeholder="Кратко, своими словами" />
                  </div>
                )}
                {!editable && visit.complaints && (
                  <div>
                    <div className="text-sm font-medium mb-1">Тезисы врача (жалобы)</div>
                    <div className="rounded-md border bg-slate-50 px-3 py-2 text-sm whitespace-pre-wrap">{visit.complaints}</div>
                  </div>
                )}

                {editable && (
                  <div className="flex flex-wrap gap-2 items-center">
                    <Button onClick={() => aiDraft()} disabled={aiLoading} className="bg-emerald-600 hover:bg-emerald-700">
                      {aiLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Bot className="h-4 w-4 mr-1" />}
                      AI-черновик протокола
                    </Button>
                    {aiUsed && <Badge variant="outline" className="text-emerald-700 border-emerald-300">AI применён</Badge>}
                  </div>
                )}

                <div>
                  <div className="text-sm font-medium mb-1">Протокол приёма</div>
                  {editable ? (
                    <Textarea value={protocolText} onChange={(e) => setProtocolText(e.target.value)} rows={8} className="text-sm" placeholder="Текст протокола (формируется по шаблону или AI-черновиком)" />
                  ) : (
                    <div className="rounded-md border bg-slate-50 px-3 py-2 text-sm whitespace-pre-wrap min-h-[120px]">{protocolText || '—'}</div>
                  )}
                </div>

                <div>
                  <div className="text-sm font-medium mb-1">Диагноз МКБ-10</div>
                  {editable ? (
                    <Input value={icdQuery} onChange={(e) => setIcdQuery(e.target.value)} placeholder="Начните вводить код или название — автоподбор МКБ-10" className="h-9" />
                  ) : (
                    <div className="rounded-md border bg-slate-50 px-3 py-2 text-sm">{diagnosisCode ? `${diagnosisCode} — ${diagnosisName}` : '—'}</div>
                  )}
                  {editable && icdSuggestions.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {icdSuggestions.map((s) => (
                        <button
                          key={s.code}
                          onClick={() => {
                            setDiagnosisCode(s.code)
                            setDiagnosisName(s.name)
                            setIcdQuery('')
                          }}
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 text-left max-w-full"
                        >
                          <span className="font-mono font-medium">{s.code}</span> <span className="text-slate-500">{s.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {diagnosisCode && (
                    <div className="mt-1.5">
                      <Badge className="bg-slate-800">
                        {diagnosisCode} — {diagnosisName}
                      </Badge>
                    </div>
                  )}
                </div>

                <div>
                  <div className="text-sm font-medium mb-1">Услуга по прайсу</div>
                  {editable ? (
                    <Select value={serviceId || 'none'} onValueChange={(v) => setServiceId(v === 'none' ? '' : v)}>
                      <SelectTrigger className="h-9" aria-label="Услуга по прайсу">
                        <SelectValue placeholder="Выберите услугу" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">— не выбрана —</SelectItem>
                        {services.map((sv) => (
                          <SelectItem key={sv.id} value={sv.id}>
                            {sv.name} · {sv.price} ₽
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="rounded-md border bg-slate-50 px-3 py-2 text-sm">
                      {services.find((sv) => sv.id === serviceId)?.name ?? '—'} {visit.price ? `· ${visit.price} ₽` : ''}
                    </div>
                  )}
                </div>

                {visit.appointment.status === 'DONE' && (
                  <div className="text-xs text-slate-500 border-t pt-3">Приём завершён — протокол доступен только для просмотра.</div>
                )}

                {editable && (
                  <div className="flex items-center justify-between gap-3 flex-wrap border-t pt-3">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <Switch checked={complete} onCheckedChange={setComplete} id="complete-switch" />
                      Завершить приём
                    </label>
                    <Button onClick={save} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700">
                      {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
                      Сохранить протокол
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <Dialog open={Boolean(aiPreview)} onOpenChange={(o) => !o && setAiPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Проверьте текст перед отправкой в ИИ</DialogTitle>
          </DialogHeader>
          {aiPreview && (
            <div className="space-y-2 text-sm">
              <div className="text-slate-600">
                Получатель: <b>{aiPreview.target.provider}</b>
                {aiPreview.target.external ? ' — внешний провайдер, данные уйдут за пределы клиники.' : ' — модель внутри контура клиники.'}{' '}
                ФИО, телефоны, адреса и организации заменены метками. Если в тексте остались данные пациента — отмените и уберите их из заметок.
              </div>
              {aiPreview.changed && <div className="text-amber-700">Текст изменился после предыдущего просмотра — проверьте ещё раз.</div>}
              <pre data-testid="ai-preview" className="max-h-80 overflow-auto whitespace-pre-wrap rounded border bg-slate-50 p-2 text-xs">{aiPreview.preview}</pre>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAiPreview(null)}>Отмена</Button>
            <Button
              variant="outline"
              onClick={() => {
                const k = aiPreview?.kind
                setAiPreview(null)
                if (k === 'protocol') aiDraft({ localOnly: true })
                else aiSummary({ localOnly: true })
              }}
            >
              Без ИИ (шаблон)
            </Button>
            <Button
              onClick={() => {
                const p = aiPreview
                setAiPreview(null)
                if (!p) return
                if (p.kind === 'protocol') aiDraft({ confirmHash: p.previewHash })
                else aiSummary({ confirmHash: p.previewHash })
              }}
            >
              Отправить в модель
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={labOpen} onOpenChange={setLabOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Направление в лабораторию</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Select value={lab} onValueChange={setLab}>
              <SelectTrigger aria-label="Лаборатория">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="INVITRO">INVITRO</SelectItem>
                <SelectItem value="HELIX">HELIX</SelectItem>
                <SelectItem value="KDL">KDL</SelectItem>
              </SelectContent>
            </Select>
            <div className="space-y-1.5">
              {LAB_TESTS.map((t) => (
                <label key={t.code} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={labTests.includes(t.code)}
                    onCheckedChange={(c) => setLabTests((prev) => (c ? [...prev, t.code] : prev.filter((x) => x !== t.code)))}
                  />
                  <span className="font-mono text-xs text-slate-500">{t.code}</span> {t.name}
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLabOpen(false)}>
              Отмена
            </Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={labSaving || labTests.length === 0} onClick={createReferral}>
              Создать направление
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {printDoc && (
        <PrintFrame title="Протокол приёма" onClose={() => setPrintDoc(null)}>
          {printDoc}
        </PrintFrame>
      )}
    </div>
  )
}

function AppointmentRow({ a, selected, onSelect }: { a: AppointmentDTO; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-lg border p-2.5 transition-colors ${
        selected ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-300' : 'bg-white hover:bg-slate-50'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-medium">{timeStr(new Date(a.start))}</span>
        <Badge className={`text-[10px] ${statusClass(a.status)}`}>{STATUS_LABELS[a.status]}</Badge>
      </div>
      <div className="text-sm truncate mt-0.5">{a.patientName}</div>
      <div className="text-xs text-slate-500 truncate">
        {a.doctorName} · {SOURCE_LABELS[a.source]}
      </div>
    </button>
  )
}
