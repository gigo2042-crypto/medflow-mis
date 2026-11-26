// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Отзыв подписанных ссылок пациента (чек-лист P1). Серверный модуль.
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { verifyLink, type LinkKind, type VerifiedLink } from '@/lib/patient-links'

type Tx = Prisma.TransactionClient | typeof db

/** Отозвать все ссылки вида kind на объект targetId, выпущенные до текущего момента. */
export async function revokeLinks(kind: LinkKind, targetId: string, reason: string | null = null, tx: Tx = db, at = new Date()) {
  // запас 1 минута: токен хранит время выпуска с точностью до минуты
  const revokedAt = new Date(at.getTime() + 60_000)
  await tx.linkRevocation.upsert({
    where: { kind_targetId: { kind, targetId } },
    create: { kind, targetId, revokedAt, reason },
    update: { revokedAt, reason },
  })
}

/** Подпись + срок жизни + отзыв. */
export async function checkLink(token: string | null | undefined, now = new Date()): Promise<VerifiedLink | null> {
  const v = verifyLink(token, now)
  if (!v) return null
  const r = await db.linkRevocation.findUnique({ where: { kind_targetId: { kind: v.kind, targetId: v.id } } })
  if (r && v.issuedAt.getTime() <= r.revokedAt.getTime()) return null
  return v
}
