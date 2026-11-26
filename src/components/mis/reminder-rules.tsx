// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { toast } from 'sonner'

interface Rule {
  level: number
  hours: number
  active: boolean
}

// Настройка каскада напоминаний (таблица ReminderRule вместо хардкода 48/24/3)
export default function ReminderRules({ canManage }: { canManage: boolean }) {
  const [rules, setRules] = useState<Rule[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api<{ rules: Rule[] }>('/api/reminder-rules')
      .then((d) => setRules(d.rules))
      .catch((e) => toast.error((e as Error).message))
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const d = await api<{ rules: Rule[] }>('/api/reminder-rules', { method: 'PUT', body: JSON.stringify({ rules }) })
      setRules(d.rules)
      toast.success('Правила каскада сохранены — применяются к новым и перенесённым записям')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Правила каскада напоминаний</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rules.map((r, i) => (
          <div key={r.level} className="flex items-center gap-3 text-sm">
            <span className="w-24 text-slate-600">Уровень {r.level}</span>
            <span className="text-slate-500">за</span>
            <Input
              type="number"
              min={1}
              max={336}
              disabled={!canManage}
              value={r.hours}
              onChange={(e) => setRules((prev) => prev.map((x, j) => (j === i ? { ...x, hours: Number(e.target.value) } : x)))}
              className="h-8 w-20"
              aria-label={`Часов до приёма, уровень ${r.level}`}
            />
            <span className="text-slate-500">ч до приёма</span>
            <Switch
              checked={r.active}
              disabled={!canManage}
              onCheckedChange={(c) => setRules((prev) => prev.map((x, j) => (j === i ? { ...x, active: c } : x)))}
              aria-label={`Уровень ${r.level} активен`}
            />
          </div>
        ))}
        {canManage && (
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" disabled={rules.length >= 5} onClick={() => setRules((p) => [...p, { level: p.length + 1, hours: Math.max(1, (p[p.length - 1]?.hours ?? 4) - 1), active: true }])}>
              Добавить уровень
            </Button>
            <Button size="sm" variant="outline" disabled={rules.length <= 1} onClick={() => setRules((p) => p.slice(0, -1))}>
              Убрать последний
            </Button>
            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" disabled={saving} onClick={save}>
              Сохранить
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
