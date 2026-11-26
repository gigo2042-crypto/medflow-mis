// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

// Флоу онлайн-записи (ФТ-012): направление → врач → слот → контакты + согласие на ПДн →
// код из SMS → запись; после записи — приглашение в бот MAX. Используется в публичной
// странице /book (встраивается на сайт клиники через /embed.js) и во вкладке персонала.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { WidgetConfigDTO } from '@/lib/types'
import { toast } from 'sonner'
import { ddmm, timeStr, zonedParts } from '@/lib/mis-utils'
import { SmartCaptcha } from '@/components/mis/smart-captcha'
import { Check, ChevronLeft, Loader2, ArrowRight, BadgeCheck, MessageSquare, Clock3 } from 'lucide-react'

type Step = 'direction' | 'doctor' | 'slot' | 'contacts' | 'code' | 'done'

function fmtDT(iso: string): string {
  const d = new Date(iso)
  const day = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'][zonedParts(d).weekday]
  return `${day}, ${ddmm(d)} в ${timeStr(d)}`
}

export default function BookingFlow({ variant, onConfig }: { variant: 'mockup' | 'page'; onConfig?: (c: WidgetConfigDTO) => void }) {
  const [config, setConfig] = useState<WidgetConfigDTO | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const [step, setStep] = useState<Step>('direction')
  const [direction, setDirection] = useState<string | null>(null)
  const [doctor, setDoctor] = useState<WidgetConfigDTO['directions'][number]['doctors'][number] | null>(null)
  const [dayIdx, setDayIdx] = useState(0)
  const [slot, setSlot] = useState<{ start: string; time: string } | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [draft, setDraft] = useState<{ draftId: string; code?: string; expiresAt: string } | null>(null)
  const [captchaToken, setCaptchaToken] = useState('')
  const [codeInput, setCodeInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [consent, setConsent] = useState(false)
  const [marketing, setMarketing] = useState(false)
  const [showConsent, setShowConsent] = useState(false)
  const [done, setDone] = useState<{ start: string; doctorName: string; patientName: string; remindersCreated: number; maxInviteUrl: string | null } | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api<WidgetConfigDTO>('/api/widget')
      setConfig(data)
      onConfig?.(data)
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [onConfig])

  useEffect(() => {
    load()
  }, [load])

  const slotsOfDoctor = useMemo(() => {
    if (!config || !doctor || dayIdx >= config.days.length) return []
    const day = config.days[dayIdx]
    return day.doctors.find((d) => d.doctorId === doctor.id)?.slots ?? []
  }, [config, doctor, dayIdx])

  const restart = () => {
    setStep('direction')
    setDirection(null)
    setDoctor(null)
    setSlot(null)
    setName('')
    setPhone('')
    setDraft(null)
    setCodeInput('')
    setConsent(false)
    setMarketing(false)
    setDone(null)
    setDayIdx(0)
    load()
  }

  const requestCode = async () => {
    if (!doctor || !slot) return
    if (name.trim().split(/\s+/).length < 2) {
      toast.error('Укажите фамилию и имя')
      return
    }
    if (phone.replace(/\D/g, '').length < 10) {
      toast.error('Телефон в формате +7 999 123-45-67')
      return
    }
    if (!consent) {
      toast.error('Нужно согласие на обработку персональных данных')
      return
    }
    setBusy(true)
    try {
      if (config?.captchaSiteKey && !captchaToken) {
        toast.error('Подтвердите, что вы не робот')
        return
      }
      const res = await api<{ draftId: string; code?: string; expiresAt: string }>('/api/widget', {
        method: 'POST',
        body: JSON.stringify({ action: 'init', doctorId: doctor.id, start: slot.start, name, phone, captchaToken, consent, consentVersion: config?.consent?.version, marketingConsent: marketing }),
      })
      setDraft(res)
      setStep('code')
      toast.success(res.code ? `Демо: SMS не отправляется, код — ${res.code}` : 'Код отправлен по SMS')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const confirmCode = async () => {
    if (!draft) return
    setBusy(true)
    try {
      const res = await api<{
        appointment: { start: string; doctorName: string }
        patientName: string
        remindersCreated: number
        maxInviteUrl: string | null
      }>('/api/widget', {
        method: 'POST',
        body: JSON.stringify({ action: 'confirm', draftId: draft.draftId, code: codeInput }),
      })
      setDone({
        start: res.appointment.start,
        doctorName: res.appointment.doctorName,
        patientName: res.patientName,
        remindersCreated: res.remindersCreated,
        maxInviteUrl: res.maxInviteUrl ?? null,
      })
      setStep('done')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const stepTitles: Array<{ id: Step; label: string }> = [
    { id: 'direction', label: 'Направление' },
    { id: 'doctor', label: 'Врач' },
    { id: 'slot', label: 'Слот' },
    { id: 'contacts', label: 'Контакты' },
    { id: 'code', label: 'Код' },
  ]
  const stepIdx = stepTitles.findIndex((s) => s.id === step)

  // Встраивание: сообщаем родительской странице высоту, чтобы iframe подстраивался (см. public/embed.js)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (variant !== 'page' || typeof window === 'undefined' || window.parent === window || !rootRef.current) return
    const el = rootRef.current
    const ro = new ResizeObserver(() => window.parent.postMessage({ type: 'medflow:height', height: el.scrollHeight }, '*'))
    ro.observe(el)
    return () => ro.disconnect()
  }, [variant])

  return (
    <div ref={rootRef} className="bg-white flex flex-col">
              <div className="bg-emerald-600 text-white px-4 py-3">
                <div className="text-sm font-semibold">{config?.clinicName || 'Онлайн-запись'}</div>
                <div className="text-[11px] opacity-80">Онлайн-запись · подтверждение сразу</div>
              </div>

              <div className="px-4 pt-3 flex items-center gap-1">
                {stepTitles.map((s, i) => (
                  <div
                    key={s.id}
                    className={`h-1 flex-1 rounded-full ${step === 'done' || i <= stepIdx ? 'bg-emerald-500' : 'bg-slate-200'}`}
                    title={s.label}
                  />
                ))}
              </div>

              <div className={`flex-1 px-4 py-3 space-y-3 ${variant === 'mockup' ? 'overflow-y-auto max-h-[430px]' : ''}`}>
                {err && <div className="text-xs text-rose-600 py-8 text-center">{err}</div>}
                {!config && !err && (
                  <div className="flex items-center justify-center py-16 text-slate-400">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </div>
                )}

                {config && !config.consent && (
                  <div className="text-sm text-slate-600 py-8 text-center">
                    Онлайн-запись временно недоступна. Пожалуйста, позвоните в клинику.
                    {variant === 'mockup' && (
                      <div className="text-[11px] text-amber-700 mt-2">Для сотрудников: загрузите утверждённый текст согласия на обработку ПДн — npm run cli -- consent-text --file …</div>
                    )}
                  </div>
                )}

                {config && config.consent && step === 'direction' && (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Выберите направление</div>
                    {config.directions.map((d) => (
                      <button
                        key={d.specialty}
                        type="button"
                        onClick={() => {
                          setDirection(d.specialty)
                          setDoctor(null)
                          setStep('doctor')
                        }}
                        className="w-full text-left rounded-lg border border-slate-200 px-3 py-2.5 hover:border-emerald-400 hover:bg-emerald-50 transition-colors"
                      >
                        <div className="text-sm font-medium text-slate-700">{d.specialty}</div>
                        <div className="text-xs text-slate-400">врачей: {d.doctors.length}</div>
                      </button>
                    ))}
                  </div>
                )}

                {config && step === 'doctor' && direction && (
                  <div className="space-y-2">
                    <button type="button" className="text-xs text-slate-500 flex items-center gap-1" onClick={() => setStep('direction')}>
                      <ChevronLeft className="h-3 w-3" /> {direction}
                    </button>
                    <div className="text-sm font-medium">Выберите врача</div>
                    {config.directions
                      .find((d) => d.specialty === direction)
                      ?.doctors.map((doc) => (
                        <button
                          key={doc.id}
                          type="button"
                          onClick={() => {
                            setDoctor(doc)
                            setSlot(null)
                            setStep('slot')
                          }}
                          className="w-full text-left rounded-lg border border-slate-200 px-3 py-2.5 hover:border-emerald-400 hover:bg-emerald-50 transition-colors"
                        >
                          <div className="text-sm font-medium text-slate-700">{doc.name}</div>
                          {doc.nearest && (
                            <div className="text-xs text-emerald-600">
                              ближайший слот: {(config.days.find((d) => d.date === doc.nearest!.date)?.label.split(' · ')[0] || doc.nearest.date).toLowerCase()} {doc.nearest.time}
                            </div>
                          )}
                        </button>
                      ))}
                  </div>
                )}

                {config && step === 'slot' && doctor && (
                  <div className="space-y-2">
                    <button type="button" className="text-xs text-slate-500 flex items-center gap-1" onClick={() => setStep('doctor')}>
                      <ChevronLeft className="h-3 w-3" /> {doctor.name}
                    </button>
                    <div className="text-sm font-medium">Дата и время</div>
                    <div className="flex gap-1.5">
                      {config.days.map((d, i) => (
                        <button
                          key={d.date}
                          type="button"
                          onClick={() => {
                            setDayIdx(i)
                            setSlot(null)
                          }}
                          className={`h-8 flex-1 rounded-md border text-[11px] font-medium ${
                            dayIdx === i
                              ? 'bg-emerald-600 text-white border-emerald-600'
                              : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                    {slotsOfDoctor.length === 0 ? (
                      <div className="text-xs text-slate-400 py-3 text-center">На этот день слотов нет</div>
                    ) : (
                      <div className="grid grid-cols-4 gap-1.5">
                        {slotsOfDoctor.map((s) => (
                          <button
                            key={s.start}
                            type="button"
                            onClick={() => setSlot(s)}
                            aria-pressed={slot?.start === s.start}
                            className={`h-9 rounded-md border text-xs font-medium ${
                              slot?.start === s.start
                                ? 'bg-emerald-600 text-white border-emerald-600'
                                : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                            }`}
                          >
                            {s.time}
                          </button>
                        ))}
                      </div>
                    )}
                    <Button
                      className="w-full bg-emerald-600 hover:bg-emerald-700 h-9"
                      disabled={!slot}
                      onClick={() => setStep('contacts')}
                    >
                      Далее <ArrowRight className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  </div>
                )}

                {config && step === 'contacts' && doctor && slot && (
                  <div className="space-y-2">
                    <div className="text-xs text-slate-500">
                      {doctor.name} · {fmtDT(slot.start)}
                    </div>
                    <div className="text-sm font-medium">Ваши данные</div>
                    <Input placeholder="Фамилия Имя" value={name} onChange={(e) => setName(e.target.value)} className="h-9" />
                    <Input placeholder="+7 999 123-45-67" value={phone} onChange={(e) => setPhone(e.target.value)} className="h-9" inputMode="tel" />
                    <div className="text-[11px] text-slate-400 flex items-center gap-1">
                      <Clock3 className="h-3 w-3" /> Слот удерживается за вами 15 минут
                    </div>
                    <label className="flex items-start gap-2 text-[11px] text-slate-600 cursor-pointer">
                      <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                      <span>
                        Даю согласие на обработку моих персональных данных, включая сведения о здоровье, на условиях{' '}
                        <button type="button" className="underline text-emerald-700" onClick={() => setShowConsent((v) => !v)}>
                          текста согласия
                        </button>{' '}
                        <span className="text-rose-600">*</span>
                      </span>
                    </label>
                    {showConsent && config?.consent && (
                      <div className="text-[11px] text-slate-600 bg-slate-50 border rounded-md p-2 max-h-40 overflow-y-auto whitespace-pre-wrap">{config.consent.text}</div>
                    )}
                    <label className="flex items-start gap-2 text-[11px] text-slate-500 cursor-pointer">
                      <input type="checkbox" className="mt-0.5" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
                      <span>Согласен получать новости и предложения клиники (необязательно, можно отписаться в любой момент)</span>
                    </label>
                    {config?.captchaSiteKey && <SmartCaptcha siteKey={config.captchaSiteKey} onToken={setCaptchaToken} />}
                    <Button className="w-full bg-emerald-600 hover:bg-emerald-700 h-9" disabled={busy || !consent} onClick={requestCode}>
                      {busy ? 'Отправляю код...' : 'Получить код по SMS'}
                    </Button>
                  </div>
                )}

                {step === 'code' && draft && (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Код из SMS</div>
                    <div className="text-xs text-slate-500">Отправлен на {phone || 'ваш номер'}</div>
                    <Input
                      placeholder="6 цифр"
                      value={codeInput}
                      onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className="h-9 text-center text-lg tracking-[0.5em] font-mono"
                      inputMode="numeric"
                    />
                    {draft.code && (
                      <div className="text-[11px] text-amber-600 bg-amber-50 rounded-md px-2 py-1.5">
                        Демо-стенд: SMS не отправляются, код — {draft.code}
                      </div>
                    )}
                    <Button className="w-full bg-emerald-600 hover:bg-emerald-700 h-9" disabled={busy || codeInput.length !== 6} onClick={confirmCode}>
                      {busy ? 'Подтверждаю...' : 'Подтвердить и записаться'}
                    </Button>
                  </div>
                )}

                {step === 'done' && done && (
                  <div className="text-center py-6 space-y-3">
                    <div className="mx-auto h-12 w-12 rounded-full bg-emerald-100 flex items-center justify-center">
                      <Check className="h-7 w-7 text-emerald-600" />
                    </div>
                    <div className="text-base font-semibold text-slate-800">Вы записаны!</div>
                    <div className="text-sm text-slate-600">{done.doctorName}</div>
                    <div className="text-sm text-slate-600 font-medium">{fmtDT(done.start)}</div>
                    <Badge className="bg-emerald-100 text-emerald-700">
                      <BadgeCheck className="h-3 w-3 mr-1" /> запись подтверждена
                    </Badge>
                    <div className="text-[11px] text-slate-400 flex items-center justify-center gap-1">
                      <MessageSquare className="h-3 w-3" />
                      напомним за {done.remindersCreated > 0 ? '48 / 24 / 3 ч' : '48 ч и ближе'} до приёма
                    </div>
                    {done.maxInviteUrl && (
                      <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-left space-y-1.5">
                        <div className="text-xs font-medium text-sky-900">Напоминания в MAX вместо SMS</div>
                        <div className="text-[11px] text-sky-800">Откройте бота клиники и нажмите «Начать» — напоминания придут в мессенджер, отменить или подтвердить визит можно кнопкой.</div>
                        <a href={done.maxInviteUrl} target="_blank" rel="noopener noreferrer" className="inline-block text-xs font-medium text-white bg-sky-600 hover:bg-sky-700 rounded-md px-3 py-1.5">
                          Подключить MAX
                        </a>
                      </div>
                    )}
                    <Button variant="outline" className="h-8 text-xs" onClick={restart}>
                      Записать ещё
                    </Button>
                  </div>
                )}
              </div>
    </div>
  )
}
