// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { ddmmHHMM } from '@/lib/mis-utils'
import { toast } from 'sonner'

interface SegmentDTO {
  id: string
  name: string
  size: number
  filter: Record<string, unknown>
}
interface CampaignDTO {
  id: string
  name: string
  segmentName: string
  channel: string
  text: string
  status: string
  recipients: number
  sentAt: string | null
}

const FILTER_LABELS: Record<string, string> = {
  gender: 'пол',
  ageFrom: 'возраст от',
  ageTo: 'возраст до',
  lastVisitMonthsMin: 'не были, мес.',
  birthdayInDays: 'ДР в ближайшие, дн.',
  noShowMin: 'неявок не меньше',
}

// Маркетинговые кампании (чеклист п.14): сегменты по обезличенным признакам и рассылки
// только пациентам с согласием на рекламу. Маркетолог видит размеры сегментов, но не ПДн.
export default function Campaigns() {
  const [segments, setSegments] = useState<SegmentDTO[]>([])
  const [campaigns, setCampaigns] = useState<CampaignDTO[]>([])
  const [segName, setSegName] = useState('')
  const [gender, setGender] = useState('any')
  const [ageFrom, setAgeFrom] = useState('')
  const [ageTo, setAgeTo] = useState('')
  const [months, setMonths] = useState('')
  const [cName, setCName] = useState('')
  const [cSeg, setCSeg] = useState('')
  const [cChannel, setCChannel] = useState('SMS')
  const [cText, setCText] = useState('')

  const load = useCallback(async () => {
    try {
      const d = await api<{ segments: SegmentDTO[]; campaigns: CampaignDTO[] }>('/api/campaigns')
      setSegments(d.segments)
      setCampaigns(d.campaigns)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const post = async (body: Record<string, unknown>, ok: string) => {
    try {
      await api('/api/campaigns', { method: 'POST', body: JSON.stringify(body) })
      toast.success(ok)
      load()
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    }
  }

  const num = (v: string) => (v.trim() === '' ? undefined : Number(v))

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Сегменты</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Input placeholder="Название сегмента" value={segName} onChange={(e) => setSegName(e.target.value)} />
            <div className="grid grid-cols-2 gap-2">
              <Select value={gender} onValueChange={setGender}>
                <SelectTrigger aria-label="Пол">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Любой пол</SelectItem>
                  <SelectItem value="F">Женщины</SelectItem>
                  <SelectItem value="M">Мужчины</SelectItem>
                </SelectContent>
              </Select>
              <Input type="number" placeholder="Не были, мес." value={months} onChange={(e) => setMonths(e.target.value)} />
              <Input type="number" placeholder="Возраст от" value={ageFrom} onChange={(e) => setAgeFrom(e.target.value)} />
              <Input type="number" placeholder="Возраст до" value={ageTo} onChange={(e) => setAgeTo(e.target.value)} />
            </div>
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={async () => {
                const ok = await post(
                  {
                    action: 'CREATE_SEGMENT',
                    name: segName,
                    filter: { gender: gender === 'any' ? undefined : gender, ageFrom: num(ageFrom), ageTo: num(ageTo), lastVisitMonthsMin: num(months) },
                  },
                  'Сегмент создан'
                )
                if (ok) setSegName('')
              }}
            >
              Создать сегмент
            </Button>
          </div>
          <div className="space-y-1.5">
            {segments.length === 0 && <div className="text-sm text-slate-500">Сегментов пока нет.</div>}
            {segments.map((s) => (
              <div key={s.id} className="rounded-md border px-3 py-2 text-sm flex items-center justify-between gap-2">
                <div>
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-slate-500">
                    {Object.entries(s.filter)
                      .filter(([, v]) => v !== undefined && v !== null)
                      .map(([k, v]) => `${FILTER_LABELS[k] ?? k}: ${String(v)}`)
                      .join(' · ') || 'все с согласием на рассылку'}
                  </div>
                </div>
                <Badge variant="outline">{s.size} чел.</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Кампании</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Input placeholder="Название кампании" value={cName} onChange={(e) => setCName(e.target.value)} />
            <div className="grid grid-cols-2 gap-2">
              <Select value={cSeg} onValueChange={setCSeg}>
                <SelectTrigger aria-label="Сегмент">
                  <SelectValue placeholder="Сегмент" />
                </SelectTrigger>
                <SelectContent>
                  {segments.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} ({s.size})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={cChannel} onValueChange={setCChannel}>
                <SelectTrigger aria-label="Канал">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SMS">SMS</SelectItem>
                  <SelectItem value="EMAIL">E-mail</SelectItem>
                  <SelectItem value="MAX">MAX (непривязанным — SMS)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Textarea rows={3} placeholder="Текст. Можно {{patient.firstName}}. Строка отписки добавляется автоматически." value={cText} onChange={(e) => setCText(e.target.value)} />
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={async () => {
                const ok = await post({ action: 'CREATE_CAMPAIGN', name: cName, segmentId: cSeg, channel: cChannel, text: cText }, 'Черновик кампании создан')
                if (ok) {
                  setCName('')
                  setCText('')
                }
              }}
            >
              Создать черновик
            </Button>
          </div>
          <div className="space-y-1.5">
            {campaigns.length === 0 && <div className="text-sm text-slate-500">Кампаний пока нет.</div>}
            {campaigns.map((c) => (
              <div key={c.id} className="rounded-md border px-3 py-2 text-sm space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{c.name}</span>
                  <Badge className={c.status === 'SENT' ? 'bg-emerald-600' : 'bg-slate-500'}>{c.status === 'SENT' ? `Отправлена · ${c.recipients}` : 'Черновик'}</Badge>
                </div>
                <div className="text-xs text-slate-500">
                  {c.segmentName} · {c.channel}
                  {c.sentAt ? ` · ${ddmmHHMM(new Date(c.sentAt))}` : ''}
                </div>
                <div className="text-xs text-slate-600 whitespace-pre-wrap">{c.text}</div>
                {c.status === 'DRAFT' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (window.confirm(`Отправить кампанию «${c.name}»? Сообщения уйдут через Центр уведомлений.`)) post({ action: 'SEND', id: c.id }, 'Кампания поставлена в очередь')
                    }}
                  >
                    Отправить
                  </Button>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
