// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Loader2, ShieldAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { ddmmyyyy } from '@/lib/mis-utils'
import { toast } from 'sonner'

interface Card {
  id: string
  cardNumber: string
  lastName: string
  firstName: string
  middleName: string | null
  phone: string
  email: string | null
  marketingConsent: boolean
  pdConsentAt: string | null
  pdConsentVersion: string | null
  pdConsentSource: string | null
  pdConsentRevokedAt: string | null
  anonymizedAt: string | null
  consents: Array<{ kind: string; action: string; version: string | null; source: string; createdAt: string }>
}

// Карточка пациента: правка данных, согласия (152-ФЗ, 38-ФЗ) и обезличивание по требованию
export default function PatientCardDialog({
  patientId,
  open,
  onOpenChange,
  onChanged,
  canAnonymize = false,
}: {
  patientId: string
  open: boolean
  onOpenChange: (v: boolean) => void
  onChanged?: () => void
  /** patients.manage (только администратор): без права блок обезличивания не показывается */
  canAnonymize?: boolean
}) {
  const [card, setCard] = useState<Card | null>(null)
  const [form, setForm] = useState({ lastName: '', firstName: '', middleName: '', phone: '', email: '' })
  const [busy, setBusy] = useState(false)
  const [confirmAnon, setConfirmAnon] = useState('')
  const [maxInfo, setMaxInfo] = useState<{ linked: boolean; linkedAt: string | null; configured: boolean; problem: string | null; inviteUrl: string | null } | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    api<{ patient: Card }>(`/api/patients/${patientId}`)
      .then((d) => {
        if (!alive) return
        setCard(d.patient)
        setForm({
          lastName: d.patient.lastName,
          firstName: d.patient.firstName,
          middleName: d.patient.middleName ?? '',
          phone: d.patient.phone,
          email: d.patient.email ?? '',
        })
      })
      .catch((e) => toast.error((e as Error).message))
    api<NonNullable<typeof maxInfo>>(`/api/patients/${patientId}/max`)
      .then((m) => alive && setMaxInfo(m))
      .catch(() => alive && setMaxInfo(null))
    return () => {
      alive = false
    }
  }, [open, patientId])

  const maxAction = async (action: 'SEND_INVITE' | 'UNLINK') => {
    setBusy(true)
    try {
      const r = await api<{ notificationStatus?: string }>(`/api/patients/${patientId}/max`, { method: 'POST', body: JSON.stringify({ action }) })
      toast.success(action === 'SEND_INVITE' ? `Приглашение отправлено по SMS (${r.notificationStatus ?? 'в очереди'})` : 'Привязка MAX снята — напоминания пойдут по SMS')
      setMaxInfo(await api<NonNullable<typeof maxInfo>>(`/api/patients/${patientId}/max`))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const patch = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true)
    try {
      const d = await api<{ patient: Card }>(`/api/patients/${patientId}`, { method: 'PATCH', body: JSON.stringify(body) })
      setCard(d.patient)
      toast.success(ok)
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const anonymize = async () => {
    setBusy(true)
    try {
      await api(`/api/patients/${patientId}`, { method: 'DELETE', body: JSON.stringify({ confirm: confirmAnon }) })
      toast.success('Пациент обезличен')
      onChanged?.()
      onOpenChange(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Карточка пациента {card ? `· ${card.cardNumber}` : ''}</DialogTitle>
          <DialogDescription>Правка данных, согласия и права субъекта ПДн</DialogDescription>
        </DialogHeader>
        {!card ? (
          <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
        ) : card.anonymizedAt ? (
          <div className="text-sm text-slate-600">Карточка обезличена {ddmmyyyy(new Date(card.anonymizedAt))}. Правка невозможна.</div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Input aria-label="Фамилия" placeholder="Фамилия" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
              <Input aria-label="Имя" placeholder="Имя" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
              <Input aria-label="Отчество" placeholder="Отчество" value={form.middleName} onChange={(e) => setForm({ ...form, middleName: e.target.value })} />
              <Input aria-label="Телефон" placeholder="Телефон" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <Input aria-label="E-mail" placeholder="E-mail" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="col-span-2" />
            </div>
            <Button size="sm" disabled={busy} onClick={() => patch({ ...form, middleName: form.middleName || null, email: form.email || null }, 'Карточка сохранена')}>
              Сохранить данные
            </Button>

            <div className="rounded-lg border p-3 space-y-2 text-sm">
              <div className="font-medium">Согласия</div>
              <div>
                Обработка ПДн:{' '}
                {card.pdConsentRevokedAt ? (
                  <span className="text-rose-600">отозвано {ddmmyyyy(new Date(card.pdConsentRevokedAt))}</span>
                ) : card.pdConsentAt ? (
                  <span className="text-emerald-700">
                    дано {ddmmyyyy(new Date(card.pdConsentAt))} ({card.pdConsentSource}, версия {card.pdConsentVersion ?? '—'})
                  </span>
                ) : (
                  <span className="text-amber-700">не зафиксировано</span>
                )}
              </div>
              <div className="flex gap-2 flex-wrap">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => patch({ pdConsent: 'GIVEN_PAPER' }, 'Согласие (бумажное) зафиксировано')}>
                  Зафиксировать бумажное согласие
                </Button>
                <Button size="sm" variant="outline" disabled={busy || !!card.pdConsentRevokedAt} onClick={() => patch({ pdConsent: 'REVOKED' }, 'Отзыв согласия зафиксирован')}>
                  Отзыв согласия
                </Button>
              </div>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={card.marketingConsent}
                  disabled={busy}
                  onCheckedChange={(v) => patch({ marketingConsent: v === true }, v === true ? 'Согласие на рассылки дано' : 'Пациент отписан от рассылок')}
                />
                Согласен(на) на рекламные рассылки (38-ФЗ ст.18)
              </label>
              {card.consents.length > 0 && (
                <div className="text-xs text-slate-500 max-h-24 overflow-y-auto">
                  {card.consents.map((c, i) => (
                    <div key={i}>
                      {ddmmyyyy(new Date(c.createdAt))} · {c.kind === 'PD' ? 'ПДн' : 'реклама'} · {c.action === 'GIVEN' ? 'дано' : 'отозвано'} · {c.source}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {maxInfo && (
              <div className="rounded-lg border p-3 space-y-2 text-sm">
                <div className="font-medium">Мессенджер MAX</div>
                {!maxInfo.configured ? (
                  <div className="text-xs text-amber-700">{maxInfo.problem}</div>
                ) : maxInfo.linked ? (
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span>Подключён{maxInfo.linkedAt ? ` с ${ddmmyyyy(new Date(maxInfo.linkedAt))}` : ''} — напоминания приходят в MAX</span>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => maxAction('UNLINK')}>Отключить</Button>
                  </div>
                ) : (
                  <div className="space-y-1.5 text-xs">
                    <div className="text-slate-600">
                      Не подключён — напоминания уходят по SMS. Бот MAX не может написать пациенту первым: пациент должен открыть ссылку и нажать «Начать».
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => maxAction('SEND_INVITE')}>Отправить приглашение по SMS</Button>
                      {maxInfo.inviteUrl && (
                        <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(maxInfo.inviteUrl!).then(() => toast.success('Ссылка скопирована'))}>
                          Копировать ссылку
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {canAnonymize && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 space-y-2 text-sm">
              <div className="font-medium flex items-center gap-1 text-rose-700">
                <ShieldAlert className="h-4 w-4" /> Обезличивание по требованию пациента
              </div>
              <div className="text-xs text-slate-600">
                ФИО, телефон, e-mail и заметки будут стёрты, будущие записи отменены. Медицинская документация сохраняется без идентификаторов.
                Введите «ОБЕЗЛИЧИТЬ» для подтверждения.
              </div>
              <div className="flex gap-2">
                <Input aria-label="Подтверждение обезличивания" value={confirmAnon} onChange={(e) => setConfirmAnon(e.target.value)} placeholder="ОБЕЗЛИЧИТЬ" />
                <Button size="sm" variant="destructive" disabled={busy || confirmAnon !== 'ОБЕЗЛИЧИТЬ'} onClick={anonymize}>
                  Обезличить
                </Button>
              </div>
            </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
