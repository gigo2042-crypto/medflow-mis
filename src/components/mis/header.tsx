// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useEffect, useState } from 'react'
import { HeartPulse, LogOut } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Me } from '@/lib/rbac'
import { ROLE_LABELS } from '@/lib/types'
import { clockStr } from '@/lib/mis-utils'

interface Props {
  me: Me
  onLogout: () => void
}

export default function Header({ me, onLogout }: Props) {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    const t0 = setTimeout(() => setNow(new Date()), 0)
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => {
      clearTimeout(t0)
      clearInterval(t)
    }
  }, [])
  return (
    <header className="bg-white border-b sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 rounded-lg bg-emerald-600 text-white flex items-center justify-center shrink-0">
            <HeartPulse className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold leading-tight">MedFlow</div>
            <div className="text-xs text-slate-500 leading-tight truncate">МИС для частных клиник</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="hidden sm:inline-flex text-slate-600">
            Лицензия: 3 одновременных места
          </Badge>
          <Badge className="bg-emerald-600 font-mono tabular-nums hidden md:inline-flex">{now ? clockStr(now) : '--:--:--'}</Badge>
          <div className="hidden sm:block text-right leading-tight">
            <div className="text-xs font-medium text-slate-800">{me.name}</div>
            <div className="text-[10px] text-slate-500">{ROLE_LABELS[me.role] || me.role} · <span className="font-mono">{me.login}</span></div>
          </div>
          <Button variant="outline" size="sm" className="h-8" onClick={onLogout} aria-label="Выйти из системы">
            <LogOut className="h-3.5 w-3.5 mr-1" /> Выйти
          </Button>
        </div>
      </div>
    </header>
  )
}
