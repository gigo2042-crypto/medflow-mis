// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import { Me } from '@/lib/rbac'
import { toast } from 'sonner'

// Баннер демо-стенда: данные вымышленные, наружу ничего не отправляется.
// Администратор может сбросить данные к исходному состоянию (также — ежедневно по расписанию).
export default function DemoBanner({ me }: { me: Me | null }) {
  const [busy, setBusy] = useState(false)
  const reset = async () => {
    if (!window.confirm('Сбросить все данные демо-стенда к исходным? Все сессии будут завершены.')) return
    setBusy(true)
    try {
      await api('/api/demo/reset', { method: 'POST' })
      toast.success('Демо-данные сброшены')
      setTimeout(() => window.location.reload(), 800)
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <div role="status" className="w-full bg-amber-400 text-amber-950 text-xs sm:text-sm">
      <div className="max-w-7xl mx-auto px-4 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold uppercase tracking-wide">Демо</span>
        <span>Демонстрационный стенд: все пациенты и данные вымышлены, SMS и письма наружу не отправляются, данные сбрасываются ежедневно.</span>
        {me?.role === 'ADMIN' && (
          <button onClick={reset} disabled={busy} className="ml-auto rounded border border-amber-900/40 px-2 py-0.5 hover:bg-amber-300 disabled:opacity-50">
            {busy ? 'Сброс…' : 'Сбросить демо-данные'}
          </button>
        )}
      </div>
    </div>
  )
}
