// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

// Документы и печатные формы (ФТ-009, ФТ-054): конструктор форм клиники
// с подстановками, клик-подписью пациента и архивом подписанных документов

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import PatientSearch from '@/components/mis/patient-search'
import PrintFrame from '@/components/mis/print-frame'
import { api } from '@/lib/api'
import { Me, can } from '@/lib/rbac'
import { DocTemplateDTO, PatientLite, SignedDocDTO } from '@/lib/types'
import { toast } from 'sonner'
import { FileSignature, FileText, Loader2, Printer, ShieldCheck, XCircle, CheckCircle2 } from 'lucide-react'
import { ddmmyyyy, timeStr } from '@/lib/mis-utils'

interface Props {
  me: Me
}

interface VisitLite {
  id: string
  createdAt: string
  doctorName: string
  diagnosisCode: string | null
}

const KIND_LABELS: Record<string, string> = {
  CONTRACT: 'Договор',
  CONSENT: 'Согласие',
  FORM: 'Форма',
}

export default function Documents({ me }: Props) {
  const canSign = can(me, 'docs.sign')

  const [templates, setTemplates] = useState<DocTemplateDTO[]>([])
  const [patient, setPatient] = useState<PatientLite | null>(null)
  const [visits, setVisits] = useState<VisitLite[]>([])
  const [visitId, setVisitId] = useState('none')
  const [templateId, setTemplateId] = useState('')
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null)
  const [rendering, setRendering] = useState(false)
  const [signing, setSigning] = useState(false)
  const [archive, setArchive] = useState<SignedDocDTO[]>([])
  const [printDoc, setPrintDoc] = useState<{ title: string; content: string } | null>(null)

  const loadTemplates = useCallback(async () => {
    try {
      const d = await api<{ templates: DocTemplateDTO[] }>('/api/doc-templates')
      setTemplates(d.templates)
      if (d.templates.length > 0) setTemplateId((prev) => prev || d.templates[0].id)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [])

  const loadArchive = useCallback(async (patientId: string) => {
    try {
      const d = await api<{ documents: SignedDocDTO[] }>(`/api/documents?patientId=${patientId}`)
      setArchive(d.documents)
    } catch {
      setArchive([])
    }
  }, [])

  useEffect(() => {
    loadTemplates()
  }, [loadTemplates])

  const pickPatient = (p: PatientLite) => {
    setPatient(p)
    setVisitId('none')
    loadArchive(p.id)
    api<{ visits: Array<{ id: string; createdAt: string; doctor: { name: string }; diagnosisCode: string | null; appointment: { start: string } | null }> }>(`/api/visits?patientId=${p.id}`)
      .then((d) => {
        // дата приёма — из записи (appointment.start); по умолчанию выбран последний приём (чеклист п.10)
        const list = d.visits
          .map((v) => ({ id: v.id, createdAt: v.appointment?.start ?? v.createdAt, doctorName: v.doctor.name, diagnosisCode: v.diagnosisCode }))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        setVisits(list)
        setVisitId(list[0]?.id ?? 'none')
      })
      .catch(() => setVisits([]))
  }

  // Рендер документа с подстановками (серверный движок, ФТ-009)
  useEffect(() => {
    if (!patient || !templateId) {
      setPreview(null)
      return
    }
    let cancelled = false
    setRendering(true)
    api<{ title: string; content: string }>('/api/doc-templates/render', {
      method: 'POST',
      body: JSON.stringify({ patientId: patient.id, templateId, visitId: visitId !== 'none' ? visitId : undefined }),
    })
      .then((d) => {
        if (!cancelled) setPreview(d)
      })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => {
        if (!cancelled) setRendering(false)
      })
    return () => {
      cancelled = true
    }
  }, [patient, templateId, visitId])

  const sign = async () => {
    if (!patient || !templateId) return
    setSigning(true)
    try {
      await api('/api/documents', {
        method: 'POST',
        body: JSON.stringify({
          patientId: patient.id,
          templateId,
          visitId: visitId !== 'none' ? visitId : undefined,
          signed: true,
        }),
      })
      toast.success('Документ подписан пациентом (клик-подпись) и сохранён в архиве')
      loadArchive(patient.id)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSigning(false)
    }
  }

  const activeTemplate = templates.find((t) => t.id === templateId)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4">
      {/* Выбор пациента, шаблона и приёма */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <FileSignature className="h-4 w-4 text-emerald-600" /> Документы клиники
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {patient ? (
              <div className="flex items-center justify-between rounded-lg border bg-emerald-50 border-emerald-200 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {patient.lastName} {patient.firstName}
                  </div>
                  <div className="text-xs text-slate-500">карта {patient.cardNumber} · {patient.phone}</div>
                </div>
                <Button size="sm" variant="ghost" className="h-7 text-xs shrink-0" onClick={() => setPatient(null)}>
                  сменить
                </Button>
              </div>
            ) : (
              <PatientSearch onPick={pickPatient} placeholder="Кому готовим документ?" />
            )}

            {patient && (
              <>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Шаблон печатной формы</div>
                  <div className="space-y-1">
                    {templates.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setTemplateId(t.id)}
                        className={`w-full text-left rounded-md border px-2.5 py-2 transition-colors ${
                          templateId === t.id ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-300' : 'bg-white hover:bg-slate-50'
                        }`}
                        aria-pressed={templateId === t.id}
                      >
                        <div className="flex items-center gap-2">
                          {t.kind === 'CONSENT' ? <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 shrink-0" /> : t.kind === 'CONTRACT' ? <FileSignature className="h-3.5 w-3.5 text-emerald-600 shrink-0" /> : <FileText className="h-3.5 w-3.5 text-slate-400 shrink-0" />}
                          <span className="text-xs leading-snug">{t.name}</span>
                        </div>
                        <Badge variant="outline" className="text-[10px] mt-1 text-slate-500">
                          {KIND_LABELS[t.kind] || t.kind}
                        </Badge>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-xs text-slate-500 mb-1">Приём для данных (необязательно)</div>
                  <Select value={visitId} onValueChange={setVisitId}>
                    <SelectTrigger aria-label="Приём для подстановки данных">
                      <SelectValue placeholder="Без приёма" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Без приёма</SelectItem>
                      {visits.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {ddmmyyyy(new Date(v.createdAt))} · {v.doctorName} · {v.diagnosisCode || '—'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Архив подписанных документов */}
        {patient && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Архив документов пациента</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 max-h-64 overflow-y-auto">
              {archive.length === 0 && <div className="text-sm text-slate-500">Подписанных документов нет.</div>}
              {archive.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 bg-white">
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{d.title}</div>
                    <div className="text-[11px] text-slate-400">
                      {ddmmyyyy(new Date(d.createdAt))} {timeStr(new Date(d.createdAt))} · {d.createdByName || '—'}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {d.signed ? (
                      <Badge variant="outline" className="text-emerald-700 border-emerald-300 text-[10px]">
                        <CheckCircle2 className="h-3 w-3 mr-0.5" /> подписан
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-slate-500 text-[10px]">
                        <XCircle className="h-3 w-3 mr-0.5" /> черновик
                      </Badge>
                    )}
                    <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={() => setPrintDoc({ title: d.title, content: d.content })} aria-label={`Печать: ${d.title}`}>
                      <Printer className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Предпросмотр документа */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm">{activeTemplate ? `Предпросмотр: ${activeTemplate.name}` : 'Предпросмотр документа'}</CardTitle>
            <div className="flex items-center gap-2">
              {preview && (
                <Button size="sm" variant="outline" onClick={() => setPrintDoc(preview)}>
                  <Printer className="h-3.5 w-3.5 mr-1" /> Печать / PDF
                </Button>
              )}
              {preview && canSign && (
                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" disabled={signing} onClick={sign}>
                  {signing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
                  Подписать пациентом
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Alert className="border-emerald-200 bg-emerald-50 mb-3">
            <ShieldCheck className="h-4 w-4 text-emerald-700" />
            <AlertTitle className="text-sm">Клик-подпись (ФТ-054)</AlertTitle>
            <AlertDescription className="text-xs text-slate-600">
              В продакшене подпись подтверждается SMS-кодом; PDF-копия сохраняется в хранилище, содержимое рендерится на сервере и не может быть подменено клиентом.
            </AlertDescription>
          </Alert>

          {!patient && <div className="p-8 text-center text-sm text-slate-500">Выберите пациента — документ соберётся автоматически с подстановками данных карты.</div>}

          {patient && rendering && (
            <div className="flex items-center gap-2 text-sm text-slate-500 p-8 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Готовим документ…
            </div>
          )}

          {patient && !rendering && preview && (
            <div className="rounded-lg border bg-white text-slate-900 px-8 py-6 font-serif text-[13px] leading-relaxed whitespace-pre-wrap max-h-[600px] overflow-y-auto">
              {preview.content}
            </div>
          )}
        </CardContent>
      </Card>

      {printDoc && (
        <PrintFrame title={printDoc.title} onClose={() => setPrintDoc(null)}>
          {printDoc.content}
        </PrintFrame>
      )}
    </div>
  )
}
