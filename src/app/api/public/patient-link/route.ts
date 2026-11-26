// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { audit } from '@/lib/auth-server'
import { checkLink } from '@/lib/link-revocation'
import { linkInfo, performPatientAction, type PatientAction } from '@/lib/patient-actions'
import { hit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/request-ip'

export const dynamic = 'force-dynamic'

const ACTIONS: PatientAction[] = ['confirm', 'cancel', 'book', 'decline', 'unsubscribe']

// Публичный ответ пациента по подписанной ссылке из SMS (вход не нужен).
// GET — только просмотр (без побочных эффектов: превью ссылок в мессенджерах не должно
// отменять записи), POST — действие по нажатию кнопки на странице.
export async function GET(req: NextRequest) {
  const v = await checkLink(req.nextUrl.searchParams.get('t'))
  if (!v || v.kind === 'max') return NextResponse.json({ error: 'Ссылка недействительна' }, { status: 404 })
  const info = await linkInfo(v.kind, v.id)
  if (!info) return NextResponse.json({ error: 'Ссылка недействительна' }, { status: 404 })
  return NextResponse.json(info, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req)
  const rl = await hit(`plink:${ip}`, 30, 10 * 60_000, 10 * 60_000)
  if (!rl.allowed) return NextResponse.json({ error: 'Слишком много запросов, попробуйте позже' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } })
  const body = await req.json().catch(() => ({}))
  const v = await checkLink(typeof body.t === 'string' ? body.t : null)
  if (!v || v.kind === 'max') return NextResponse.json({ error: 'Ссылка недействительна' }, { status: 404 })
  const action = body.action as PatientAction
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 })
  try {
    const r = await performPatientAction(v.kind, v.id, action, 'UNSUBSCRIBE_LINK', ip)
    if (r.auditAction) await audit(r.auditAction, null, { kind: v.kind, id: v.id, via: 'link' })
    return NextResponse.json({ ok: r.ok, message: r.message }, { status: r.ok ? 200 : 409 })
  } catch (e) {
    console.error('[public/patient-link]', e)
    return NextResponse.json({ error: 'Не удалось выполнить действие' }, { status: 500 })
  }
}
