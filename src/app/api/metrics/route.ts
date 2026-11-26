// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { collectMetrics, metricsAuthorized } from '@/lib/metrics'

export const dynamic = 'force-dynamic'

// Метрики Prometheus. Выключено, пока не задан METRICS_TOKEN (404); доступ — Authorization: Bearer <METRICS_TOKEN>.
// Снаружи (Caddy) путь закрыт; Prometheus ходит на app:3000 внутри docker-сети.
export async function GET(req: NextRequest) {
  const a = metricsAuthorized(req.headers.get('authorization'))
  if (a === 'disabled') return new NextResponse('Not Found', { status: 404 })
  if (a === 'denied') return new NextResponse('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } })
  return new NextResponse(await collectMetrics(), {
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
  })
}
