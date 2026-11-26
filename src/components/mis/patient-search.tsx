// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Loader2, UserPlus, Search } from 'lucide-react'
import { api } from '@/lib/api'
import { PatientLite } from '@/lib/types'
import { ageFromBirthDate } from '@/lib/mis-utils'
import { toast } from 'sonner'

interface Props {
  onPick: (p: PatientLite) => void
  placeholder?: string
}

// Универсальный поиск пациента + инлайн-создание карты (точка улучшения №1)
export default function PatientSearch({ onPick, placeholder }: Props) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<PatientLite[]>([])
  // Без запроса сервер отдаёт только записанных на ближайшие дни; вся картотека — явным действием (пишется в аудит)
  const [showAll, setShowAll] = useState(false)
  const [scope, setScope] = useState<'upcoming' | 'all' | 'search'>('upcoming')
  const [loading, setLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ lastName: '', firstName: '', phone: '', pdConsent: false, marketingConsent: false })
  const [saving, setSaving] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (query: string, all: boolean) => {
    setLoading(true)
    try {
      const qs = query.trim() ? `q=${encodeURIComponent(query)}` : all ? 'all=1&pageSize=50' : 'pageSize=50'
      const data = await api<{ patients: PatientLite[] }>(`/api/patients?${qs}`)
      setResults(data.patients)
      setScope(query.trim() ? 'search' : all ? 'all' : 'upcoming')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => load(q, showAll), 250)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [q, showAll, load])

  const create = async () => {
    if (!form.lastName || !form.firstName || !form.phone) {
      toast.error('Заполните фамилию, имя и телефон')
      return
    }
    if (!form.pdConsent) {
      toast.error('Без подписанного согласия на обработку ПДн карту завести нельзя (152-ФЗ)')
      return
    }
    setSaving(true)
    try {
      const data = await api<{
        patient: {
          id: string
          cardNumber: string
          lastName: string
          firstName: string
          middleName: string | null
          phone: string
          gender: string
        }
      }>('/api/patients', { method: 'POST', body: JSON.stringify(form) })
      const p: PatientLite = { ...data.patient, birthDate: null, notes: null, appointmentCount: 0, noShowCount: 0 }
      toast.success(`Пациент создан, карта ${p.cardNumber}`)
      onPick(p)
      setShowCreate(false)
      setForm({ lastName: '', firstName: '', phone: '', pdConsent: false, marketingConsent: false })
      setQ('')
      load('', showAll)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder || 'Поиск: ФИО, телефон или номер карты — устойчив к опечаткам'}
          className="pl-9"
          aria-label="Поиск пациента"
        />
        {loading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-slate-400" />}
      </div>
      {scope !== 'search' && (
        <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
          <span>{scope === 'all' ? 'Вся картотека (просмотр записан в журнал аудита)' : 'Записанные на сегодня и ближайшие 7 дней — остальных найдите поиском'}</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Только записанные' : 'Показать всю картотеку'}
          </Button>
        </div>
      )}
      <div className="max-h-56 overflow-y-auto rounded-lg border divide-y bg-white">
        {results.length === 0 && (
          <div className="p-3 text-sm text-slate-500">{scope === 'upcoming' ? 'На ближайшие дни никто не записан — найдите пациента поиском или создайте нового ниже.' : 'Пациенты не найдены — создайте нового за один шаг ниже.'}</div>
        )}
        {results.map((p) => (
          <button
            key={p.id}
            onClick={() => onPick(p)}
            className="w-full text-left p-3 hover:bg-emerald-50 transition-colors flex items-center justify-between gap-2"
          >
            <div className="min-w-0">
              <div className="font-medium text-sm truncate">
                {p.lastName} {p.firstName}
                {p.middleName ? ` ${p.middleName}` : ''}
              </div>
              <div className="text-xs text-slate-500 truncate">
                {p.phone} · карта {p.cardNumber} · {ageFromBirthDate(p.birthDate)}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {p.noShowCount > 0 && (
                <Badge variant="outline" className="text-rose-600 border-rose-200">
                  {p.noShowCount} неявок
                </Badge>
              )}
              <Badge variant="outline" className="text-slate-500">
                {p.appointmentCount} визитов
              </Badge>
            </div>
          </button>
        ))}
      </div>
      {!showCreate ? (
        <Button variant="outline" size="sm" onClick={() => setShowCreate(true)} className="w-full">
          <UserPlus className="h-4 w-4 mr-1" /> Создать нового пациента
        </Button>
      ) : (
        <div className="rounded-lg border p-3 space-y-2 bg-slate-50">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Input placeholder="Фамилия" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
            <Input placeholder="Имя" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
            <Input placeholder="Телефон" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <label className="flex items-start gap-2 text-xs text-slate-700">
            <Checkbox checked={form.pdConsent} onCheckedChange={(v) => setForm({ ...form, pdConsent: v === true })} aria-label="Согласие на обработку ПДн" />
            Пациент подписал согласие на обработку персональных данных, включая сведения о здоровье (обязательно)
          </label>
          <label className="flex items-start gap-2 text-xs text-slate-700">
            <Checkbox checked={form.marketingConsent} onCheckedChange={(v) => setForm({ ...form, marketingConsent: v === true })} aria-label="Согласие на рассылки" />
            Согласен(на) на рекламные рассылки (необязательно)
          </label>
          <div className="flex gap-2">
            <Button size="sm" onClick={create} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700">
              {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <UserPlus className="h-4 w-4 mr-1" />}
              Создать карту
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)}>
              Отмена
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
