// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { canAccessPatient, canSeeMedical } from '@/lib/pd-access'
import { anonymizePatient, recordConsent } from '@/lib/consent'
import { scrubPd } from '@/lib/pii'
import { clientIp } from '@/lib/request-ip'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

function dto(p: NonNullable<Awaited<ReturnType<typeof load>>>, medical: boolean) {
  return {
    id: p.id,
    cardNumber: p.cardNumber,
    lastName: p.lastName,
    firstName: p.firstName,
    middleName: p.middleName,
    phone: p.phone,
    email: p.email,
    birthDate: p.birthDate?.toISOString() ?? null,
    gender: p.gender,
    // заметки врача («Важно: …») — медицинские сведения, только medical.read
    notes: medical ? p.notes : null,
    marketingConsent: p.marketingConsent,
    marketingConsentAt: p.marketingConsentAt?.toISOString() ?? null,
    pdConsentAt: p.pdConsentAt?.toISOString() ?? null,
    pdConsentVersion: p.pdConsentVersion,
    pdConsentSource: p.pdConsentSource,
    pdConsentRevokedAt: p.pdConsentRevokedAt?.toISOString() ?? null,
    anonymizedAt: p.anonymizedAt?.toISOString() ?? null,
    consents: p.consents.map((c) => ({
      kind: c.kind,
      action: c.action,
      version: c.version,
      source: c.source,
      createdAt: c.createdAt.toISOString(),
    })),
  }
}

function load(id: string) {
  return db.patient.findUnique({ where: { id }, include: { consents: { orderBy: { createdAt: 'desc' }, take: 50 } } })
}

// Карточка пациента с историей согласий (152-ФЗ ст.14: сведения субъекту по запросу)
export async function GET(req: NextRequest, ctx: Ctx) {
  const g = await requirePerm(req, 'patients.read')
  if (!g.ok) return g.res
  const { id } = await ctx.params
  if (!(await canAccessPatient(g.user, id))) return NextResponse.json({ error: 'Нет доступа к пациенту' }, { status: 403 })
  const p = await load(id)
  if (!p) return NextResponse.json({ error: 'Пациент не найден' }, { status: 404 })
  await audit('patient.card_read', g.user.id, { patientId: id, via: 'card' })
  return NextResponse.json({ patient: dto(p, canSeeMedical(g.user)) })
}

// Правка карточки и согласий. body: { lastName?, firstName?, middleName?, phone?, email?, birthDate?, gender?, notes?,
//   marketingConsent?: boolean, pdConsent?: 'GIVEN_PAPER' | 'REVOKED' }
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const g = await requirePerm(req, 'patients.manage')
  if (!g.ok) return g.res
  const { id } = await ctx.params
  try {
    const p = await db.patient.findUnique({ where: { id } })
    if (!p) return NextResponse.json({ error: 'Пациент не найден' }, { status: 404 })
    if (p.anonymizedAt) return NextResponse.json({ error: 'Карточка обезличена — правка невозможна' }, { status: 409 })
    const body = await req.json()
    if ('notes' in body && !canSeeMedical(g.user)) {
      return NextResponse.json({ error: 'Заметки врача — медицинские сведения, правка доступна только врачу' }, { status: 403 })
    }
    const data: Record<string, unknown> = {}
    const changed: string[] = []
    for (const k of ['lastName', 'firstName', 'middleName', 'phone', 'email', 'notes'] as const) {
      if (k in body) {
        const v = body[k] === null ? null : String(body[k] ?? '').trim()
        if ((k === 'lastName' || k === 'firstName' || k === 'phone') && !v) {
          return NextResponse.json({ error: 'Фамилия, имя и телефон не могут быть пустыми' }, { status: 400 })
        }
        if (k === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
          return NextResponse.json({ error: 'Некорректный e-mail' }, { status: 400 })
        }
        data[k] = v || null
        changed.push(k)
      }
    }
    if ('gender' in body) {
      data.gender = body.gender === 'M' ? 'M' : 'F'
      changed.push('gender')
    }
    if ('birthDate' in body) {
      const bd = body.birthDate ? new Date(body.birthDate) : null
      if (bd && (Number.isNaN(bd.getTime()) || bd.getTime() > Date.now())) {
        return NextResponse.json({ error: 'Некорректная дата рождения' }, { status: 400 })
      }
      data.birthDate = bd
      changed.push('birthDate')
    }
    if (Object.keys(data).length) await db.patient.update({ where: { id }, data })

    const ip = clientIp(req)
    if (typeof body.marketingConsent === 'boolean' && body.marketingConsent !== p.marketingConsent) {
      await recordConsent({ patientId: id, kind: 'MARKETING', action: body.marketingConsent ? 'GIVEN' : 'REVOKED', source: 'REGISTRAR', staffId: g.user.id, ip })
      changed.push('marketingConsent')
    }
    if (body.pdConsent === 'GIVEN_PAPER') {
      await recordConsent({ patientId: id, kind: 'PD', action: 'GIVEN', source: 'PAPER', version: String(body.pdConsentVersion || 'paper'), staffId: g.user.id, ip })
      changed.push('pdConsent')
    } else if (body.pdConsent === 'REVOKED') {
      await recordConsent({ patientId: id, kind: 'PD', action: 'REVOKED', source: 'REGISTRAR', staffId: g.user.id, ip })
      changed.push('pdConsentRevoked')
    }
    // в аудите — только имена полей, без значений (ПДн)
    await audit('patient.updated', g.user.id, { patientId: id, fields: changed })
    const fresh = await load(id)
    return NextResponse.json({ patient: dto(fresh!, canSeeMedical(g.user)) })
  } catch (e) {
    console.error('[patients PATCH]', e)
    return NextResponse.json({ error: 'Не удалось сохранить карточку' }, { status: 500 })
  }
}

// Обезличивание по требованию субъекта (152-ФЗ ст.21). Физического удаления медкарты нет:
// медицинская документация подлежит хранению, поэтому стираются идентификаторы личности.
// body: { confirm: 'ОБЕЗЛИЧИТЬ', reason?: string }
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const g = await requirePerm(req, 'patients.manage')
  if (!g.ok) return g.res
  const { id } = await ctx.params
  try {
    const body = await req.json().catch(() => ({}))
    if (body.confirm !== 'ОБЕЗЛИЧИТЬ') {
      return NextResponse.json({ error: 'Подтвердите обезличивание: confirm = «ОБЕЗЛИЧИТЬ»' }, { status: 400 })
    }
    // причину пишет сотрудник свободным текстом — ФИО/телефон пациента из неё убираем до записи в аудит
    const before = await db.patient.findUnique({ where: { id }, select: { lastName: true, firstName: true, middleName: true, phone: true, email: true } })
    const reason = before
      ? scrubPd(String(body.reason || '').slice(0, 200), { names: [before.lastName, before.firstName, before.middleName], phones: [before.phone], emails: [before.email] })
      : ''
    const res = await anonymizePatient(id)
    await audit('patient.anonymized', g.user.id, { patientId: id, canceledAppointments: res.canceledAppointments, scrubbed: res.scrubbed, reason })
    return NextResponse.json({ ok: true, ...res })
  } catch (e) {
    const msg = (e as Error).message
    if (msg === 'Пациент не найден') return NextResponse.json({ error: msg }, { status: 404 })
    console.error('[patients DELETE]', e)
    return NextResponse.json({ error: 'Не удалось обезличить пациента' }, { status: 500 })
  }
}
