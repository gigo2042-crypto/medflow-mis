// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { audit, requireService } from '@/lib/auth-server'
import { tickScheduler } from '@/lib/reports-run'
import { expireWidgetDrafts } from '@/lib/waiting'

export const dynamic = 'force-dynamic'

// Служебный тик планировщика отчётов: вызывается мини-сервисом scheduler
// (:3042) по расписанию через x-service-key. Идемпотентен по nextRunAt:
// расписание выполняется, когда момент настал.
export async function POST(req: NextRequest) {
  const g = requireService(req)
  if (!g.ok) return g.res
  try {
    // Заодно — очистка черновиков виджета (ПДн не держим дольше суток, даже если виджетом никто не пользуется)
    await expireWidgetDrafts().catch((e) => console.error('[scheduler/tick] widget drafts', e))
    const res = await tickScheduler()
    if (res.due > 0) {
      await audit('reports.scheduler_tick', null, { due: res.due, statuses: res.results.map((r) => r.status) })
    }
    return NextResponse.json({ ok: true, ...res })
  } catch (e) {
    console.error('[reports/scheduler/tick POST]', e)
    return NextResponse.json({ error: 'Ошибка тика планировщика' }, { status: 500 })
  }
}
