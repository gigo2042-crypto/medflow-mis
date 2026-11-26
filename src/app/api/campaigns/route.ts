// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { enqueue, processOutbox } from '@/lib/notify'
import { matchesSegment, parseFilter, SegmentPatient } from '@/lib/segments'
import { patientLink } from '@/lib/patient-links'

export const dynamic = 'force-dynamic'

const MAX_TEXT = 600

async function segmentPatients(filterJson: string) {
  const f = parseFilter(filterJson)
  const rows = await db.patient.findMany({
    where: { marketingConsent: true, anonymizedAt: null },
    select: {
      id: true, firstName: true, lastName: true, phone: true, email: true, gender: true, birthDate: true, marketingConsent: true, maxUserId: true,
      appointments: { select: { status: true, start: true } },
    },
  })
  return rows.filter((r) => {
    const sp: SegmentPatient = {
      id: r.id,
      gender: r.gender,
      birthDate: r.birthDate,
      marketingConsent: r.marketingConsent,
      lastVisitAt: r.appointments.filter((a) => a.status === 'DONE').reduce<Date | null>((m, a) => (!m || a.start > m ? a.start : m), null),
      noShows: r.appointments.filter((a) => a.status === 'NO_SHOW').length,
    }
    return matchesSegment(sp, f)
  })
}

// Маркетинговые кампании: сегменты и рассылки (право campaigns.manage).
// Маркетолог видит только размер сегмента, не персональные данные пациентов.
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'campaigns.manage')
  if (!g.ok) return g.res
  const [segments, campaigns] = await Promise.all([
    db.segment.findMany({ orderBy: { createdAt: 'desc' } }),
    db.campaign.findMany({ orderBy: { createdAt: 'desc' }, include: { segment: { select: { name: true } } }, take: 50 }),
  ])
  const sizes = await Promise.all(segments.map(async (s) => (await segmentPatients(s.filterJson)).length))
  return NextResponse.json({
    segments: segments.map((s, i) => ({ id: s.id, name: s.name, filter: parseFilter(s.filterJson), size: sizes[i], createdAt: s.createdAt.toISOString() })),
    campaigns: campaigns.map((c) => ({
      id: c.id, name: c.name, segmentId: c.segmentId, segmentName: c.segment.name, channel: c.channel, text: c.text,
      status: c.status, recipients: c.recipients, sentAt: c.sentAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString(),
    })),
  })
}

export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'campaigns.manage')
  if (!g.ok) return g.res
  try {
    const body = await req.json()
    const action = body.action

    if (action === 'CREATE_SEGMENT') {
      const name = String(body.name || '').trim()
      if (name.length < 3) return NextResponse.json({ error: 'Название сегмента — не короче 3 символов' }, { status: 400 })
      const filter = parseFilter(JSON.stringify(body.filter ?? {}))
      const seg = await db.segment.create({ data: { name: name.slice(0, 120), filterJson: JSON.stringify(filter) } })
      await audit('campaigns.segment_created', g.user.id, { segmentId: seg.id })
      return NextResponse.json({ segment: { id: seg.id, size: (await segmentPatients(seg.filterJson)).length } }, { status: 201 })
    }

    if (action === 'CREATE_CAMPAIGN') {
      const name = String(body.name || '').trim()
      const text = String(body.text || '').trim()
      // MAX — только пациентам, привязанным к боту; остальным Центр уведомлений отправит SMS (фолбэк)
      const channel = ['SMS', 'EMAIL', 'MAX'].includes(body.channel) ? body.channel : 'SMS'
      const seg = body.segmentId ? await db.segment.findUnique({ where: { id: String(body.segmentId) } }) : null
      if (name.length < 3) return NextResponse.json({ error: 'Название кампании — не короче 3 символов' }, { status: 400 })
      if (!seg) return NextResponse.json({ error: 'Выберите сегмент' }, { status: 400 })
      if (text.length < 5 || text.length > MAX_TEXT) return NextResponse.json({ error: `Текст — от 5 до ${MAX_TEXT} символов` }, { status: 400 })
      const c = await db.campaign.create({ data: { name: name.slice(0, 120), segmentId: seg.id, channel, text, createdById: g.user.id } })
      await audit('campaigns.created', g.user.id, { campaignId: c.id })
      return NextResponse.json({ campaign: { id: c.id } }, { status: 201 })
    }

    if (action === 'SEND') {
      const c = await db.campaign.findUnique({ where: { id: String(body.id || '') }, include: { segment: true } })
      if (!c) return NextResponse.json({ error: 'Кампания не найдена' }, { status: 404 })
      if (c.status !== 'DRAFT') return NextResponse.json({ error: 'Кампания уже отправлена' }, { status: 409 })
      // атомарно занимаем кампанию, чтобы двойной клик не отправил дважды
      const claimed = await db.campaign.updateMany({ where: { id: c.id, status: 'DRAFT' }, data: { status: 'SENDING' } })
      if (claimed.count === 0) return NextResponse.json({ error: 'Кампания уже отправляется' }, { status: 409 })
      const patients = await segmentPatients(c.segment.filterJson)
      let queued = 0
      for (const p of patients) {
        const to = c.channel === 'EMAIL' ? p.email : p.phone
        if (!to) continue
        const text = c.text.replace(/\{\{\s*patient\.firstName\s*\}\}/g, p.firstName)
        // Входящие SMS шлюз не принимает — отписка по персональной ссылке (в MAX дополнительно команда «СТОП»)
        const unsub = `Отписаться: ${patientLink('u', p.id)}`
        await enqueue({ kind: 'CAMPAIGN', channel: c.channel === 'MAX' && !p.maxUserId ? 'SMS' : c.channel, phone: to, text: `${text} ${unsub}`, patientId: p.id, patientName: `${p.lastName} ${p.firstName}` })
        queued++
      }
      await db.campaign.update({ where: { id: c.id }, data: { status: 'SENT', recipients: queued, sentAt: new Date() } })
      await audit('campaigns.sent', g.user.id, { campaignId: c.id, recipients: queued })
      await processOutbox(50)
      return NextResponse.json({ ok: true, recipients: queued })
    }

    if (action === 'DELETE_SEGMENT') {
      const id = String(body.id || '')
      const used = await db.campaign.count({ where: { segmentId: id } })
      if (used > 0) return NextResponse.json({ error: 'Сегмент используется в кампаниях' }, { status: 409 })
      await db.segment.delete({ where: { id } }).catch(() => undefined)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 })
  } catch (e) {
    console.error('[campaigns POST]', e)
    return NextResponse.json({ error: 'Ошибка кампаний' }, { status: 500 })
  }
}
