// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest } from 'next/server'

// IP клиента за обратным прокси. Клиент может прислать свой X-Forwarded-For —
// поэтому берём не первое (подделываемое) значение, а то, что дописал наш
// последний доверенный прокси: TRUST_PROXY_HOPS (по умолчанию 1 — Caddy или ALB).
// TRUST_PROXY_HOPS=0 — приложение доступно напрямую, заголовки прокси игнорируются.
export function clientIpFrom(headers: { get(name: string): string | null }, hopsEnv = process.env.TRUST_PROXY_HOPS): string {
  const hops = Math.max(0, Number(hopsEnv ?? '1') || 0)
  if (hops === 0) return 'direct'
  const xff = headers.get('x-forwarded-for')
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean)
    const ip = parts[Math.max(0, parts.length - hops)]
    if (ip) return ip
  }
  return headers.get('x-real-ip') || 'unknown'
}

export function clientIp(req: NextRequest): string {
  return clientIpFrom(req.headers)
}
