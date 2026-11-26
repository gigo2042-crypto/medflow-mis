// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Согласия пациента (152-ФЗ ст.9/10, 38-ФЗ ст.18) и права субъекта (ст.14, 21).
// Серверный модуль — не импортировать в клиентский код!
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import { containsPatientPd, nameStem, scrubPd, type ScrubOptions } from '@/lib/pii'

export type ConsentKind = 'PD' | 'MARKETING'
export type ConsentSource = 'WIDGET' | 'REGISTRAR' | 'PAPER' | 'UNSUBSCRIBE_LINK' | 'MAX' | 'MIGRATION'

import { PD_CONSENT_TEMPLATE } from '@/lib/consent-text'
export { PD_CONSENT_TEMPLATE }

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Текущий текст согласия на обработку ПДн для онлайн-записи.
 * Текст задаёт клиника (шаблон PD_CONSENT_WIDGET, загружается командой cli consent-text), версия — PD_CONSENT_VERSION
 * или хеш текста. Без утверждённого текста онлайн-запись в production не принимается.
 */
export async function currentPdConsent(): Promise<{ text: string; version: string; hash: string } | null> {
  const t = await db.documentTemplate.findUnique({ where: { code: PD_CONSENT_TEMPLATE } })
  if (!t || !t.active || !t.body.trim()) return null
  const hash = sha256(t.body)
  return { text: t.body, version: process.env.PD_CONSENT_VERSION || `sha256:${hash.slice(0, 12)}`, hash }
}

export async function recordConsent(input: {
  patientId: string
  kind: ConsentKind
  action: 'GIVEN' | 'REVOKED'
  source: ConsentSource
  version?: string | null
  textHash?: string | null
  staffId?: string | null
  ip?: string | null
}, tx?: Prisma.TransactionClient): Promise<void> {
  const now = new Date()
  const data =
    input.kind === 'PD'
      ? input.action === 'GIVEN'
        ? { pdConsentAt: now, pdConsentVersion: input.version ?? null, pdConsentSource: input.source, pdConsentRevokedAt: null }
        : { pdConsentRevokedAt: now }
      : { marketingConsent: input.action === 'GIVEN', marketingConsentAt: now }
  const record = {
    patientId: input.patientId,
    kind: input.kind,
    action: input.action,
    version: input.version ?? null,
    textHash: input.textHash ?? null,
    source: input.source,
    staffId: input.staffId ?? null,
    ip: input.ip ?? null,
  }
  if (tx) {
    // внутри внешней транзакции (запись из виджета: пациент + приём + согласие — атомарно)
    await tx.patient.update({ where: { id: input.patientId }, data })
    await tx.consentRecord.create({ data: record })
    return
  }
  await db.$transaction([db.patient.update({ where: { id: input.patientId }, data }), db.consentRecord.create({ data: record })])
}

export const ANON_NAME = 'Обезличен'

/**
 * Обезличивание по требованию субъекта (152-ФЗ ст.21): ФИО, контакты, заметки, MAX-привязка
 * стираются; приёмы, визиты, платежи и документы остаются (обязательное хранение медицинской
 * и бухгалтерской документации) — но без идентификаторов личности. Будущие записи отменяются.
 */
export async function anonymizePatient(patientId: string): Promise<{ canceledAppointments: number; scrubbed: Record<string, number> }> {
  const p = await db.patient.findUnique({ where: { id: patientId } })
  if (!p) throw new Error('Пациент не найден')
  if (p.anonymizedAt) return { canceledAppointments: 0, scrubbed: {} }
  const now = new Date()
  const future = await db.appointment.findMany({
    where: { patientId, start: { gt: now }, status: { in: ['BOOKED', 'CONFIRMED'] } },
    select: { id: true },
  })
  const ids = future.map((a) => a.id)
  const pd: ScrubOptions = { names: [p.lastName, p.firstName, p.middleName], phones: [p.phone], emails: [p.email], patientLabel: '[пациент]' }
  const plan = await planTraceScrub(patientId, pd)
  await db.$transaction([
    db.appointment.updateMany({ where: { id: { in: ids } }, data: { status: 'CANCELED' } }),
    db.reminder.updateMany({ where: { appointmentId: { in: ids }, status: 'PLANNED' }, data: { status: 'CANCELED' } }),
    db.notification.updateMany({
      where: { patientId, status: { in: ['QUEUED', 'DEFERRED_QUIET'] } },
      data: { status: 'FAILED', error: 'Пациент обезличен' },
    }),
    // снимки ФИО/телефона в журнале уведомлений тоже стираются
    db.notification.updateMany({ where: { patientId }, data: { patientName: null, phone: '', text: '[обезличено]' } }),
    db.waitingListEntry.updateMany({ where: { patientId, status: { in: ['ACTIVE', 'OFFERED'] } }, data: { status: 'DECLINED' } }),
    db.waitingListEntry.updateMany({ where: { patientId }, data: { comment: null } }),
    // IP из согласий — тоже ПДн; сам факт, версия и хеш текста согласия остаются (доказательство)
    db.consentRecord.updateMany({ where: { patientId }, data: { ip: null } }),
    // заметка к оплате — свободный текст; суммы и фискальные реквизиты остаются (54-ФЗ, бухучёт)
    db.payment.updateMany({ where: { patientId }, data: { note: null } }),
    db.callEvent.updateMany({ where: { patientId }, data: { phone: '' } }),
    db.notificationBlacklist.deleteMany({ where: { patientId } }),
    ...plan.ops,
    // ссылки отписки и приглашения в MAX на этого пациента больше не действуют
    ...(['u', 'max'] as const).map((kind) =>
      db.linkRevocation.upsert({
        where: { kind_targetId: { kind, targetId: patientId } },
        create: { kind, targetId: patientId, revokedAt: new Date(now.getTime() + 60_000), reason: 'patient.anonymized' },
        update: { revokedAt: new Date(now.getTime() + 60_000), reason: 'patient.anonymized' },
      })
    ),
    db.patient.update({
      where: { id: patientId },
      data: {
        lastName: ANON_NAME,
        firstName: `№${p.cardNumber}`,
        middleName: null,
        phone: '',
        email: null,
        notes: null,
        birthDate: p.birthDate ? new Date(Date.UTC(p.birthDate.getUTCFullYear(), 0, 1)) : null,
        marketingConsent: false,
        marketingConsentAt: now,
        pdConsentRevokedAt: now,
        anonymizedAt: now,
        // привязка к боту MAX — идентификатор пользователя мессенджера
        maxUserId: null,
        maxLinkedAt: null,
      },
    }),
  ])
  return { canceledAppointments: ids.length, scrubbed: plan.counts }
}

/** Свободный текст: JSON чистим по строковым значениям (структура сохраняется), прочее — целиком. */
export function scrubText(text: string | null, pd: ScrubOptions): string | null {
  if (text == null || text === '') return text
  const t = text.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const walk = (v: unknown): unknown =>
        typeof v === 'string' ? scrubPd(v, pd) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v
      return JSON.stringify(walk(JSON.parse(t)))
    } catch {
      // не JSON — обычный текст
    }
  }
  return scrubPd(text, pd)
}

// Таблицы без ссылки на пациента, где могут остаться ФИО/телефон: ищем по основам фамилии/имени и цифрам телефона
const UNLINKED: Array<{ table: string; cols: string[] }> = [
  { table: 'IntegrationEvent', cols: ['summary', 'payload', 'error'] },
  { table: 'OneCExport', cols: ['xml', 'comment', 'error'] },
  { table: 'ReportRun', cols: ['summary', 'csv'] },
]

/**
 * След ПДн пациента вне карточки (чек-лист P0): визиты (жалобы, протокол, шаблон), документы,
 * направления в лабораторию, напоминания, полисы, черновики виджета, журналы интеграций,
 * выгрузки 1С и отчёты. Медицинское содержание остаётся, идентификаторы личности — заменяются.
 */
async function planTraceScrub(patientId: string, pd: ScrubOptions) {
  const ops: Prisma.PrismaPromise<unknown>[] = []
  const counts: Record<string, number> = {}
  const add = (k: string) => (counts[k] = (counts[k] ?? 0) + 1)
  const changed = (a: string | null, b: string | null) => (a ?? '') !== (b ?? '')

  for (const v of await db.visit.findMany({ where: { patientId }, select: { id: true, complaints: true, protocolText: true, templateData: true } })) {
    const data = { complaints: scrubText(v.complaints, pd), protocolText: scrubText(v.protocolText, pd), templateData: scrubText(v.templateData, pd) }
    if (changed(v.complaints, data.complaints) || changed(v.protocolText, data.protocolText) || changed(v.templateData, data.templateData)) {
      ops.push(db.visit.update({ where: { id: v.id }, data }))
      add('visit')
    }
  }
  for (const d of await db.signedDocument.findMany({ where: { patientId }, select: { id: true, title: true, content: true } })) {
    const data = { title: scrubText(d.title, pd) ?? d.title, content: scrubText(d.content, pd) ?? d.content }
    if (changed(d.title, data.title) || changed(d.content, data.content)) {
      ops.push(db.signedDocument.update({ where: { id: d.id }, data }))
      add('signedDocument')
    }
  }
  for (const l of await db.labReferral.findMany({ where: { patientId }, select: { id: true, resultText: true, error: true } })) {
    const data = { resultText: scrubText(l.resultText, pd), error: scrubText(l.error, pd) }
    if (changed(l.resultText, data.resultText) || changed(l.error, data.error)) {
      ops.push(db.labReferral.update({ where: { id: l.id }, data }))
      add('labReferral')
    }
  }
  for (const r of await db.reminder.findMany({ where: { appointment: { patientId } }, select: { id: true, text: true, response: true } })) {
    const data = { text: scrubText(r.text, pd), response: scrubText(r.response, pd) }
    if (changed(r.text, data.text) || changed(r.response, data.response)) {
      ops.push(db.reminder.update({ where: { id: r.id }, data }))
      add('reminder')
    }
  }
  for (const ip of await db.insurancePolicy.findMany({ where: { patientId }, select: { id: true, policyNumber: true } })) {
    const masked = ip.policyNumber.length > 4 ? `****${ip.policyNumber.slice(-4)}` : '****'
    if (masked !== ip.policyNumber) {
      ops.push(db.insurancePolicy.update({ where: { id: ip.id }, data: { policyNumber: masked } }))
      add('insurancePolicy')
    }
  }

  const stems = [...new Set((pd.names ?? []).flatMap((n) => String(n || '').split(/\s+/)).filter((w) => w.length >= 3).flatMap((w) => nameStem(w)).filter((s) => s.length >= 3))]
  const likes = stems.map((s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
  const ten = (pd.phones ?? []).map((x) => String(x || '').replace(/\D/g, '').slice(-10)).filter((d) => d.length === 10)
  const digitLikes = ten.map((d) => `%${d}%`)

  // Черновики виджета этого человека (по телефону или имени) — удаляются целиком
  if (ten.length || likes.length) {
    const drafts = await db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "WidgetDraft"
      WHERE regexp_replace("phone", '[^0-9]', '', 'g') LIKE ANY(${digitLikes.length ? digitLikes : ['-']}::text[])
         OR "name" ILIKE ANY(${likes.length ? likes : ['-']}::text[])`
    const draftIds: string[] = []
    for (const d of drafts) {
      const row = await db.widgetDraft.findUnique({ where: { id: d.id }, select: { id: true, name: true, phone: true } })
      if (row && containsPatientPd(`${row.name} ${row.phone}`, pd)) draftIds.push(row.id)
    }
    if (draftIds.length) {
      ops.push(db.widgetDraft.deleteMany({ where: { id: { in: draftIds } } }))
      counts.widgetDraft = draftIds.length
    }
    const bl = await db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "NotificationBlacklist" WHERE regexp_replace("phone", '[^0-9]', '', 'g') LIKE ANY(${digitLikes.length ? digitLikes : ['-']}::text[])`
    if (bl.length) {
      ops.push(db.notificationBlacklist.deleteMany({ where: { id: { in: bl.map((b) => b.id) } } }))
      counts.notificationBlacklist = bl.length
    }
    const calls = await db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "CallEvent" WHERE regexp_replace("phone", '[^0-9]', '', 'g') LIKE ANY(${digitLikes.length ? digitLikes : ['-']}::text[])`
    if (calls.length) {
      ops.push(db.callEvent.updateMany({ where: { id: { in: calls.map((c) => c.id) } }, data: { phone: '' } }))
      counts.callEvent = calls.length
    }
    for (const { table, cols } of UNLINKED) {
      const cond = cols
        .map((c) => `(COALESCE("${c}", '') ILIKE ANY($1::text[]) OR regexp_replace(COALESCE("${c}", ''), '[^0-9]', '', 'g') LIKE ANY($2::text[]))`)
        .join(' OR ')
      const rows = await db.$queryRawUnsafe<Array<Record<string, string | null>>>(
        `SELECT "id", ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}" WHERE ${cond}`,
        likes.length ? likes : ['-'],
        digitLikes.length ? digitLikes : ['-']
      )
      for (const row of rows) {
        const data: Record<string, string | null> = {}
        for (const c of cols) {
          const next = scrubText(row[c], pd)
          if (changed(row[c], next)) data[c] = c === 'summary' || c === 'payload' || c === 'xml' ? (next ?? '') : next
        }
        if (!Object.keys(data).length) continue
        const model = (db as unknown as Record<string, { update: (a: unknown) => Prisma.PrismaPromise<unknown> }>)[table[0].toLowerCase() + table.slice(1)]
        ops.push(model.update({ where: { id: row.id }, data }))
        add(table)
      }
    }
  }
  return { ops, counts }
}

