// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Начальная настройка «чистой» production-базы: справочники без персональных данных.
// Идемпотентно: существующие записи не трогает.
import type { PrismaClient } from '@prisma/client'
import { DOC_TEMPLATES, NOTIFICATION_TEMPLATES, PROTOCOL_TEMPLATES } from './data'

export async function seedReference(db: PrismaClient): Promise<Record<string, number>> {
  const out: Record<string, number> = { protocolTemplates: 0, docTemplates: 0, notificationTemplates: 0, reminderRules: 0, warehouses: 0 }
  if ((await db.protocolTemplate.count()) === 0) {
    for (const t of PROTOCOL_TEMPLATES) {
      await db.protocolTemplate.create({ data: t })
      out.protocolTemplates++
    }
  }
  if ((await db.documentTemplate.count()) === 0) {
    for (const t of DOC_TEMPLATES) {
      await db.documentTemplate.create({ data: t })
      out.docTemplates++
    }
  }
  for (const t of NOTIFICATION_TEMPLATES) {
    const exists = await db.notificationTemplate.findUnique({ where: { code: t.code } })
    if (!exists) {
      await db.notificationTemplate.create({ data: t })
      out.notificationTemplates++
    }
  }
  await db.notificationSetting.upsert({
    where: { id: 'main' },
    update: {},
    create: { id: 'main', quietFrom: '21:00', quietTo: '09:00', dailyLimit: 500, retryMinutes: 5, maxAttempts: 3 },
  })
  if ((await db.reminderRule.count()) === 0) {
    for (const r of [{ level: 1, hours: 48 }, { level: 2, hours: 24 }, { level: 3, hours: 3 }]) {
      await db.reminderRule.create({ data: r })
      out.reminderRules++
    }
  }
  if ((await db.warehouse.count()) === 0) {
    await db.warehouse.create({ data: { code: 'MAIN', name: 'Основной склад', kind: 'MAIN', active: true } })
    out.warehouses++
  }
  return out
}
