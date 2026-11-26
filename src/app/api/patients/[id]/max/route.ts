// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { isDemo } from '@/lib/config'
import { maxConfig, maxDeeplink } from '@/lib/max'
import { signLink } from '@/lib/patient-links'
import { enqueue, processOutbox } from '@/lib/notify'
import { clinicBrand } from '@/lib/clinic'

export const dynamic = 'force-dynamic'

// Привязка пациента к боту MAX. Бот не может написать первым и не ищет людей по номеру:
// пациент должен сам открыть ссылку-приглашение и нажать «Начать» — тогда вебхук
// получает bot_started с user_id и подписанным payload.
async function load(id: string) {
  return db.patient.findUnique({ where: { id }, select: { id: true, phone: true, firstName: true, maxUserId: true, maxLinkedAt: true, anonymizedAt: true } })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requirePerm(req, 'patients.edit')
  if (!g.ok) return g.res
  const { id } = await params
  const p = await load(id)
  if (!p || p.anonymizedAt) return NextResponse.json({ error: 'Пациент не найден' }, { status: 404 })
  const cfg = maxConfig()
  const available = cfg.configured || isDemo()
  return NextResponse.json({
    linked: !!p.maxUserId,
    linkedAt: p.maxLinkedAt?.toISOString() ?? null,
    configured: available,
    problem: available ? null : cfg.problem,
    inviteUrl: available ? maxDeeplink(signLink('max', p.id)) : null,
  })
}

// action: SEND_INVITE — отправить пациенту ссылку-приглашение по SMS; UNLINK — снять привязку
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requirePerm(req, 'patients.edit')
  if (!g.ok) return g.res
  const { id } = await params
  const p = await load(id)
  if (!p || p.anonymizedAt) return NextResponse.json({ error: 'Пациент не найден' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  if (body.action === 'UNLINK') {
    await db.patient.update({ where: { id }, data: { maxUserId: null, maxLinkedAt: null } })
    await audit('max.unlinked', g.user.id, { patientId: id, reason: 'staff' })
    return NextResponse.json({ ok: true })
  }
  if (body.action === 'SEND_INVITE') {
    const cfg = maxConfig()
    if (!cfg.configured && !isDemo()) return NextResponse.json({ error: cfg.problem, code: 'MAX_NOT_CONFIGURED' }, { status: 409 })
    const url = maxDeeplink(signLink('max', id))
    const q = await enqueue({
      kind: 'MANUAL', channel: 'SMS', phone: p.phone, priority: 1, patientId: id, patientName: p.firstName,
      text: `${clinicBrand()}: напоминания о записях можно получать в MAX. Откройте ссылку и нажмите «Начать»: ${url}`,
    })
    if (q.status === 'QUEUED') await processOutbox(20)
    const fresh = await db.notification.findUnique({ where: { id: q.id } })
    await audit('max.invite_sent', g.user.id, { patientId: id, notificationStatus: fresh?.status })
    return NextResponse.json({ ok: true, notificationStatus: fresh?.status ?? q.status })
  }
  return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 })
}
