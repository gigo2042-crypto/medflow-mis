// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

// Касса и прейскурант (ФТ-006, ФТ-007): оплаты с очередью фискализации 54-ФЗ,
// чек возврата, X-отчёт за день, управление прайс-листом (price.manage)

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import PatientSearch from '@/components/mis/patient-search'
import PrintFrame from '@/components/mis/print-frame'
import { api } from '@/lib/api'
import { Me, can } from '@/lib/rbac'
import { buildReceipt } from '@/lib/receipt'
import { usePublicConfig } from '@/lib/use-public-config'
import { FISCAL_NOT_REQUIRED, refundPlan, refundToast } from '@/lib/refund-policy'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { CashSummary, FISCAL_LABELS, PatientLite, PAYMENT_METHOD_LABELS, PaymentDTO, ServiceDTO } from '@/lib/types'
import { ddmmyyyy, timeStr } from '@/lib/mis-utils'
import { toast } from 'sonner'
import { BadgeCheck, Banknote, Loader2, Plus, Printer, RefreshCw, Wallet, Undo2, ClipboardList, XCircle } from 'lucide-react'

interface Props {
  me: Me
}

interface VisitLite {
  id: string
  createdAt: string
  diagnosisCode: string | null
  diagnosisName: string | null
  price: number
  doctorName: string
}


function newPayKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}

export default function Cash({ me }: Props) {
  const canPay = can(me, 'cash.pay')
  const canFiscalize = can(me, 'cash.fiscalize')
  const cfg = usePublicConfig()
  const fiscalOk = cfg?.fiscal.configured ?? false
  const clinicOk = cfg?.clinic.configured ?? false
  const canRefund = can(me, 'cash.refund')
  const canPrice = can(me, 'price.manage')
  const canOverride = can(me, 'cash.discount_override')

  const [services, setServices] = useState<ServiceDTO[]>([])
  const [payments, setPayments] = useState<PaymentDTO[]>([])
  const [summary, setSummary] = useState<CashSummary | null>(null)
  const [loading, setLoading] = useState(true)

  // Диалог оплаты
  const [payOpen, setPayOpen] = useState(false)
  const [patient, setPatient] = useState<PatientLite | null>(null)
  const [visits, setVisits] = useState<VisitLite[]>([])
  const [visitId, setVisitId] = useState<string>('none')
  const [cart, setCart] = useState<Record<string, number>>({})
  const [method, setMethod] = useState('CARD')
  const [amount, setAmount] = useState('')
  const [discount, setDiscount] = useState('')
  const [saving, setSaving] = useState(false)
  // ключ идемпотентности: один на открытие окна оплаты (двойной клик/повтор не создаст вторую оплату)
  const [payKey, setPayKey] = useState('')
  // скидка сверх лимита: код администратора (кассир) / выдача кода (администратор)
  const [approvalCode, setApprovalCode] = useState('')
  const [approvalReason, setApprovalReason] = useState('')
  const [issuedCode, setIssuedCode] = useState<string | null>(null)

  // Управление прейскурантом
  const [priceOpen, setPriceOpen] = useState(false)
  const [editing, setEditing] = useState<ServiceDTO | null>(null)
  const [pName, setPName] = useState('')
  const [pCategory, setPCategory] = useState('')
  const [pPrice, setPPrice] = useState('')
  const [pDuration, setPDuration] = useState('30')
  const [pActive, setPActive] = useState(true)
  const [priceSaving, setPriceSaving] = useState(false)

  // Возврат и печать чека
  const [refundTarget, setRefundTarget] = useState<PaymentDTO | null>(null)
  const [printPayment, setPrintPayment] = useState<PaymentDTO | null>(null)

  const load = useCallback(async () => {
    try {
      const [svc, cash] = await Promise.all([
        api<{ services: ServiceDTO[] }>('/api/services'),
        api<{ payments: PaymentDTO[]; summary: CashSummary }>('/api/payments'),
      ])
      setServices(svc.services)
      setPayments(cash.payments)
      setSummary(cash.summary)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const loadVisits = async (patientId: string) => {
    try {
      const data = await api<{ visits: Array<{ id: string; createdAt: string; diagnosisCode: string | null; diagnosisName: string | null; price: number; doctor: { name: string } }> }>(
        `/api/visits?patientId=${patientId}`
      )
      setVisits(
        data.visits
          .filter((v) => v.price > 0)
          .map((v) => ({ id: v.id, createdAt: v.createdAt, diagnosisCode: v.diagnosisCode, diagnosisName: v.diagnosisName, price: v.price, doctorName: v.doctor.name }))
      )
    } catch {
      setVisits([])
    }
  }

  const openPayDialog = () => {
    setPatient(null)
    setVisits([])
    setVisitId('none')
    setCart({})
    setMethod('CARD')
    setAmount('')
    setDiscount('')
    setApprovalCode('')
    setApprovalReason('')
    setIssuedCode(null)
    setPayKey(newPayKey())
    setPayOpen(true)
  }

  const pickPatient = (p: PatientLite) => {
    setPatient(p)
    setVisitId('none')
    loadVisits(p.id)
  }

  const cartTotal = useMemo(() => {
    let t = 0
    for (const [id, qty] of Object.entries(cart)) {
      const s = services.find((x) => x.id === id)
      if (s) t += s.price * qty
    }
    return t
  }, [cart, services])

  const totalFromAmount = Number(amount) || 0
  const selectedVisit = visits.find((v) => v.id === visitId) ?? null
  // приём с услугой из прайса: по умолчанию к оплате — его цена
  const useVisitPrice = cartTotal === 0 && !amount && selectedVisit !== null
  const grossTotal = cartTotal > 0 ? cartTotal : useVisitPrice ? selectedVisit!.price : totalFromAmount
  const discountNum = Math.max(0, Math.round(Number(discount) || 0))
  const effectiveTotal = Math.max(0, grossTotal - discountNum)

  const toggleService = (id: string) => {
    setCart((prev) => {
      const next = { ...prev }
      if (next[id]) delete next[id]
      else next[id] = 1
      return next
    })
  }

  const setQty = (id: string, qty: number) => {
    setCart((prev) => ({ ...prev, [id]: Math.max(1, Math.min(20, qty || 1)) }))
  }

  const createPayment = async () => {
    if (!patient) {
      toast.error('Выберите пациента')
      return
    }
    if (effectiveTotal <= 0) {
      toast.error('Выберите услуги или укажите сумму')
      return
    }
    setSaving(true)
    try {
      const items = Object.entries(cart).map(([serviceId, qty]) => ({ serviceId, qty }))
      await api('/api/payments', {
        method: 'POST',
        body: JSON.stringify({
          patientId: patient.id,
          visitId: visitId !== 'none' ? visitId : undefined,
          items: items.length ? items : undefined,
          amount: items.length || useVisitPrice ? undefined : totalFromAmount,
          discount: discountNum || undefined,
          discountApprovalCode: approvalCode.trim() || undefined,
          clientKey: payKey || undefined,
          method,
        }),
      })
      toast.success('Оплата принята — чек поставлен в очередь фискализации (54-ФЗ)')
      setPayOpen(false)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const issueApproval = async () => {
    if (!patient || discountNum <= 0) return
    try {
      const r = await api<{ approval: { code: string; expiresAt: string } }>('/api/payments/discount-approvals', {
        method: 'POST',
        body: JSON.stringify({ patientId: patient.id, maxDiscount: discountNum, reason: approvalReason }),
      })
      setIssuedCode(r.approval.code)
      toast.success(`Код подтверждения скидки: ${r.approval.code}`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const cancelPayment = async (p: PaymentDTO) => {
    if (!window.confirm(`Отменить оплату ${p.amount} ₽ (${p.patientName})? Чек по ней не пробит — в кассу она не уйдёт.`)) return
    try {
      await api(`/api/payments/${p.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'cancel' }) })
      toast.success('Оплата отменена')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const fiscalize = async (p: PaymentDTO) => {
    try {
      const r = await api<{ payment: { fiscalStatus: string } }>(`/api/payments/${p.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'fiscalize' }) })
      toast.success(me.mode === 'demo' ? 'Демо: фискальный чек выдан' : r.payment.fiscalStatus === 'PENDING' ? 'Чек отправлен в онлайн-кассу — результат придёт в течение минуты' : 'Фискальный чек выдан')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const doRefund = async () => {
    if (!refundTarget) return
    try {
      const r = await api<{ refund: { fiscalStatus: string } | null; fiscalNote: string | null }>(`/api/payments/${refundTarget.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'refund' }) })
      // текст — по фактическому статусу чека возврата: выдан / ждёт кассы / без чека (внешняя ККТ)
      const msg = refundToast(refundTarget.amount, r.refund?.fiscalStatus, r.fiscalNote)
      if (r.refund?.fiscalStatus === 'ISSUED' || r.refund?.fiscalStatus === FISCAL_NOT_REQUIRED) toast.success(msg)
      else toast.warning(msg)
      setRefundTarget(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
      setRefundTarget(null)
    }
  }

  const openPrice = (s: ServiceDTO | null) => {
    setEditing(s)
    setPName(s?.name || '')
    setPCategory(s?.category || 'Услуги')
    setPPrice(s ? String(s.price) : '')
    setPDuration(s ? String(s.durationMinutes) : '30')
    setPActive(s ? s.active : true)
    setPriceOpen(true)
  }

  const savePrice = async () => {
    if (!pName.trim() || !Number(pPrice)) {
      toast.error('Укажите название и цену')
      return
    }
    setPriceSaving(true)
    try {
      const payload = {
        name: pName.trim(),
        category: pCategory.trim() || 'Услуги',
        price: Math.round(Number(pPrice)),
        durationMinutes: Math.round(Number(pDuration) || 30),
        active: pActive,
      }
      if (editing) {
        await api(`/api/services/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        toast.success('Услуга обновлена (изменение цены — в аудите)')
      } else {
        await api('/api/services', { method: 'POST', body: JSON.stringify(payload) })
        toast.success('Услуга добавлена в прейскурант')
      }
      setPriceOpen(false)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setPriceSaving(false)
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<string, ServiceDTO[]>()
    for (const s of services) {
      const arr = map.get(s.category) || []
      arr.push(s)
      map.set(s.category, arr)
    }
    return Array.from(map.entries())
  }, [services])

  const receiptText = (p: PaymentDTO): string =>
    buildReceipt(p, {
      demo: me.mode === 'demo',
      clinicName: cfg?.clinic.name || '',
      clinicInn: cfg?.clinic.inn || '',
      dateLine: `${ddmmyyyy(new Date(p.createdAt))} ${timeStr(new Date(p.createdAt))}`,
      methodLabel: PAYMENT_METHOD_LABELS[p.method] || p.method,
    })

  const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4">
      {/* Прейскурант */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-emerald-600" /> Прайс-лист
            </CardTitle>
            {canPrice && (
              <Button size="sm" variant="outline" className="h-8" onClick={() => openPrice(null)}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Услуга
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 max-h-[560px] overflow-y-auto">
          {grouped.map(([category, list]) => (
            <div key={category}>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">{category}</div>
              <div className="space-y-1">
                {list.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 bg-white">
                    <div className="min-w-0">
                      <div className="text-sm truncate">{s.name}</div>
                      <div className="text-[11px] text-slate-400">{s.durationMinutes} мин</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-sm font-medium">{rub(s.price)}</span>
                      {canPrice && (
                        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => openPrice(s)} aria-label={`Изменить цену: ${s.name}`}>
                          изм.
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {services.length === 0 && !loading && <div className="text-sm text-slate-500">Прайс-лист пуст.</div>}
        </CardContent>
      </Card>

      {/* Касса за день */}
      <div className="space-y-4">
        {cfg && !fiscalOk && (
          <Alert className="border-amber-300 bg-amber-50">
            <AlertTitle className="text-sm">Онлайн-касса (54-ФЗ) не подключена</AlertTitle>
            <AlertDescription className="text-xs">
              {cfg.fiscal.problem} Оплаты сохраняются со статусом «Не фискализирован»; кассовый чек нужно выдать на аппаратной ККТ.
            </AlertDescription>
          </Alert>
        )}
        {cfg && !clinicOk && (
          <Alert className="border-rose-300 bg-rose-50">
            <AlertTitle className="text-sm">Реквизиты клиники не заданы</AlertTitle>
            <AlertDescription className="text-xs">Не заданы: {cfg.clinic.missing.join(', ')}. Печать чеков недоступна.</AlertDescription>
          </Alert>
        )}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <CardTitle className="text-sm flex items-center gap-2">
                <Wallet className="h-4 w-4 text-emerald-600" /> Касса за сегодня
              </CardTitle>
              <div className="flex items-center gap-2">
                {summary && summary.queued > 0 && (
                  <Badge variant="outline" className="text-amber-700 border-amber-300">
                    в очереди ОФД: {summary.queued}
                  </Badge>
                )}
                <Button variant="ghost" size="icon" onClick={load} aria-label="Обновить кассу">
                  <RefreshCw className="h-4 w-4" />
                </Button>
                {canPay && (
                  <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={openPayDialog}>
                    <Banknote className="h-4 w-4 mr-1" /> Принять оплату
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {summary && (
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
                <div className="rounded-lg border bg-white p-3">
                  <div className="text-[11px] text-slate-500">Выручка</div>
                  <div className="text-lg font-semibold">{rub(summary.gross)}</div>
                </div>
                <div className="rounded-lg border bg-white p-3">
                  <div className="text-[11px] text-slate-500">Возвраты</div>
                  <div className="text-lg font-semibold text-rose-600">{rub(summary.refunds)}</div>
                </div>
                <div className="rounded-lg border bg-white p-3">
                  <div className="text-[11px] text-slate-500">Итог смены (X)</div>
                  <div className="text-lg font-semibold text-emerald-700">{rub(summary.net)}</div>
                </div>
                <div className="rounded-lg border bg-white p-3">
                  <div className="text-[11px] text-slate-500">Чеков / выдано</div>
                  <div className="text-lg font-semibold">{summary.count} / {summary.issued}</div>
                </div>
                <div className="rounded-lg border bg-white p-3">
                  <div className="text-[11px] text-slate-500 mb-0.5">Способы</div>
                  <div className="text-xs text-slate-700 leading-snug">
                    {Object.entries(summary.byMethod).map(([m, v]) => (
                      <div key={m}>
                        {PAYMENT_METHOD_LABELS[m] || m}: {rub(v)}
                      </div>
                    ))}
                    {Object.keys(summary.byMethod).length === 0 && <div className="text-slate-400">—</div>}
                  </div>
                </div>
              </div>
            )}

            {refundTarget && (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
                <span className="text-sm text-rose-700">
                  Подтвердите возврат {rub(refundTarget.amount)} по оплате пациента {refundTarget.patientName} —{' '}
                  {refundTarget.fiscalStatus === 'ISSUED' ? 'будет сформирован чек возврата.' : 'возврат оформляется записью, чек возврата пробейте на внешней ККТ.'}
                </span>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" className="h-8 bg-rose-600 hover:bg-rose-700" onClick={doRefund}>
                    Да, вернуть
                  </Button>
                  <Button size="sm" variant="outline" className="h-8" onClick={() => setRefundTarget(null)}>
                    Отмена
                  </Button>
                </div>
              </div>
            )}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Время</TableHead>
                  <TableHead>Пациент / состав</TableHead>
                  <TableHead>Сумма</TableHead>
                  <TableHead>Метод</TableHead>
                  <TableHead>54-ФЗ</TableHead>
                  <TableHead className="text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-sm text-slate-500">
                      {loading ? 'Загрузка кассы…' : 'Оплат за сегодня нет — примите оплату или выберите другую дату в проде.'}
                    </TableCell>
                  </TableRow>
                )}
                {payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{timeStr(new Date(p.createdAt))}</TableCell>
                    <TableCell>
                      <div className="text-sm font-medium">{p.patientName}</div>
                      <div className="text-xs text-slate-500">{p.cardNumber}</div>
                      <div className="text-[11px] text-slate-400 truncate max-w-[210px]">
                        {p.items && p.items.length ? p.items.map((i) => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ') : p.note || '—'}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className={p.type === 'REFUND' ? 'text-rose-600 font-medium' : 'font-medium'}>{rub(p.amount)}</span>
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">{PAYMENT_METHOD_LABELS[p.method] || p.method}</TableCell>
                    <TableCell>
                      {p.fiscalStatus === 'ISSUED' ? (
                        <Badge variant="outline" className="text-emerald-700 border-emerald-300 text-[11px]">
                          <BadgeCheck className="h-3 w-3 mr-1" /> {FISCAL_LABELS.ISSUED}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className={`text-[11px] ${p.fiscalStatus === 'ERROR' ? 'text-rose-700 border-rose-300' : 'text-amber-700 border-amber-300'}`}>
                          {FISCAL_LABELS[p.fiscalStatus] || p.fiscalStatus}
                        </Badge>
                      )}
                      {p.fiscalError && <div className="text-[10px] text-rose-600 mt-0.5 max-w-[200px] truncate" title={p.fiscalError}>{p.fiscalError}</div>}
                      {p.fiscalNumber && <div className="text-[10px] text-slate-400 mt-0.5">{p.fiscalNumber}</div>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        {canFiscalize && fiscalOk && ['QUEUED', 'ERROR'].includes(p.fiscalStatus) && (
                          <Button size="sm" variant="outline" className="h-8 border-emerald-300 text-emerald-700 hover:bg-emerald-50" onClick={() => fiscalize(p)}>
                            <BadgeCheck className="h-3.5 w-3.5 mr-1" /> Фискализировать
                          </Button>
                        )}
                        {p.fiscalStatus === 'ISSUED' && clinicOk && (
                          <Button size="sm" variant="outline" className="h-8 w-8 p-0" title="Печать кассового чека" aria-label={`Печать чека: ${p.patientName}`} onClick={() => setPrintPayment(p)}>
                            <Printer className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {canRefund && p.type === 'PAYMENT' && p.status === 'PAID' && ['QUEUED', 'ERROR'].includes(p.fiscalStatus) && (
                          <Button size="sm" variant="outline" className="h-8 w-8 p-0 text-slate-600" title="Отменить оплату (чек не пробит)" aria-label={`Отменить оплату: ${p.patientName}`} onClick={() => cancelPayment(p)}>
                            <XCircle className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {canRefund && p.type === 'PAYMENT' && p.status === 'PAID' && !p.refunded && cfg && (() => {
                          const plan = refundPlan(p.fiscalStatus, fiscalOk, me.mode === 'demo')
                          return plan.ok && (p.fiscalStatus === 'ISSUED' || plan.journal)
                        })() && (
                          <Button size="sm" variant="outline" className="h-8 w-8 p-0 text-rose-600 border-rose-200 hover:bg-rose-50" title={p.fiscalStatus === 'ISSUED' ? 'Возврат с чеком возврата' : 'Возврат записью (чек возврата — на внешней ККТ)'} aria-label={`Возврат: ${p.patientName}`} onClick={() => setRefundTarget(p)}>
                            <Undo2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Диалог оплаты */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">Новая оплата (касса, ФТ-006)</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs text-slate-500">Пациент</Label>
              {patient ? (
                <div className="mt-1 flex items-center justify-between rounded-lg border bg-emerald-50 border-emerald-200 px-3 py-2">
                  <span className="text-sm">
                    {patient.lastName} {patient.firstName} · карта {patient.cardNumber} · {patient.phone}
                  </span>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPatient(null)}>
                    сменить
                  </Button>
                </div>
              ) : (
                <div className="mt-1">
                  <PatientSearch onPick={pickPatient} placeholder="Кому принимаем оплату?" />
                </div>
              )}
            </div>

            {patient && (
              <>
                <div>
                  <Label className="text-xs text-slate-500">Привязать приём (необязательно)</Label>
                  <Select value={visitId} onValueChange={setVisitId}>
                    <SelectTrigger className="mt-1" aria-label="Приём для привязки">
                      <SelectValue placeholder="Без привязки" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Без привязки</SelectItem>
                      {visits.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {ddmmyyyy(new Date(v.createdAt))} · {v.doctorName} · {v.diagnosisCode || '—'} · {v.price} ₽
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-xs text-slate-500">Услуги из прайс-листа</Label>
                  <div className="mt-1 space-y-2 max-h-64 overflow-y-auto rounded-lg border p-2 bg-slate-50">
                    {grouped.map(([category, list]) => (
                      <div key={category}>
                        <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide px-1">{category}</div>
                        {list.map((s) => {
                          const qty = cart[s.id]
                          return (
                            <div key={s.id} className="flex items-center justify-between gap-2 px-1 py-1">
                              <button onClick={() => toggleService(s.id)} className={`flex-1 text-left text-sm rounded px-2 py-1 transition-colors ${qty ? 'bg-emerald-100 text-emerald-900' : 'hover:bg-white'}`} aria-pressed={Boolean(qty)}>
                                {s.name} <span className="text-slate-400">· {s.price} ₽</span>
                              </button>
                              {qty && (
                                <Input
                                  type="number"
                                  min={1}
                                  max={20}
                                  value={qty}
                                  onChange={(e) => setQty(s.id, Number(e.target.value))}
                                  className="h-7 w-14 text-sm"
                                  aria-label={`Количество: ${s.name}`}
                                />
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </div>

                {cartTotal === 0 && (
                  <div>
                    <Label className="text-xs text-slate-500" htmlFor="cash-amount">
                      Сумма без номенклатуры (₽)
                    </Label>
                    <Input id="cash-amount" type="number" min={1} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Например: 2500" className="mt-1" />
                  </div>
                )}

                <div>
                  <Label className="text-xs text-slate-500" htmlFor="cash-discount">
                    Скидка (₽, отдельной строкой в чеке)
                  </Label>
                  <Input id="cash-discount" type="number" min={0} step={1} value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0" className="mt-1 w-40" />
                  {discountNum > 0 && !canOverride && (
                    <div className="mt-2">
                      <Label className="text-xs text-slate-500" htmlFor="cash-approval">
                        Код подтверждения администратора (нужен, если скидка больше лимита)
                      </Label>
                      <Input id="cash-approval" value={approvalCode} onChange={(e) => setApprovalCode(e.target.value)} placeholder="Например: K7M2Q9XA" className="mt-1 w-52 font-mono" />
                    </div>
                  )}
                  {discountNum > 0 && canOverride && (
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <div>
                        <Label className="text-xs text-slate-500" htmlFor="cash-approval-reason">
                          Выдать кассиру код на эту скидку — основание
                        </Label>
                        <Input id="cash-approval-reason" value={approvalReason} onChange={(e) => setApprovalReason(e.target.value)} placeholder="Например: акция «Семейная»" className="mt-1 w-64" />
                      </div>
                      <Button size="sm" variant="outline" onClick={issueApproval} disabled={approvalReason.trim().length < 3}>
                        Выдать код
                      </Button>
                      {issuedCode && <span className="font-mono text-sm text-emerald-700">{issuedCode}</span>}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                  <div>
                    <Label className="text-xs text-slate-500">Способ оплаты</Label>
                    <Select value={method} onValueChange={setMethod}>
                      <SelectTrigger className="w-[160px] mt-1" aria-label="Способ оплаты">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CASH">Наличные</SelectItem>
                        <SelectItem value="CARD">Карта</SelectItem>
                        <SelectItem value="SBP">СБП</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex-1 text-right">
                    <div className="text-xs text-slate-500">Итого к оплате</div>
                    <div className="text-2xl font-semibold text-emerald-700">{rub(effectiveTotal)}</div>
                    {discountNum > 0 && <div className="text-[11px] text-slate-500">{rub(grossTotal)} − скидка {rub(discountNum)}</div>}
                  </div>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayOpen(false)}>
              Отмена
            </Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={!patient || saving || effectiveTotal <= 0} onClick={createPayment}>
              {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Banknote className="h-4 w-4 mr-1" />}
              Принять оплату
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Диалог прейскуранта */}
      <Dialog open={priceOpen} onOpenChange={setPriceOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">{editing ? 'Изменить услугу' : 'Новая услуга прайс-листа'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="svc-name" className="text-xs text-slate-500">Название</Label>
              <Input id="svc-name" value={pName} onChange={(e) => setPName(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label htmlFor="svc-cat" className="text-xs text-slate-500">Категория</Label>
              <Input id="svc-cat" value={pCategory} onChange={(e) => setPCategory(e.target.value)} className="mt-1" list="svc-categories" />
              <datalist id="svc-categories">
                {grouped.map(([c]) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="svc-price" className="text-xs text-slate-500">Цена, ₽</Label>
                <Input id="svc-price" type="number" min={1} value={pPrice} onChange={(e) => setPPrice(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="svc-dur" className="text-xs text-slate-500">Длительность, мин</Label>
                <Input id="svc-dur" type="number" min={5} value={pDuration} onChange={(e) => setPDuration(e.target.value)} className="mt-1" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Switch checked={pActive} onCheckedChange={setPActive} id="svc-active" />
              Активна (доступна для записи и оплаты)
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPriceOpen(false)}>
              Отмена
            </Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={priceSaving} onClick={savePrice}>
              {priceSaving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
              Сохранить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Печать фискального чека */}
      {printPayment && (
        <PrintFrame title={`Кассовый чек · ${printPayment.fiscalNumber || ''}`} onClose={() => setPrintPayment(null)}>
          {receiptText(printPayment)}
        </PrintFrame>
      )}
    </div>
  )
}
