// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { isService, requireAuth } from '@/lib/auth-server'
import { demoOnly } from '@/lib/demo-guard'
import { seedDemo } from '@/demo/seed'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

let running = false

/** Полная очистка всех таблиц приложения (кроме журнала миграций). */
async function truncateAll(): Promise<void> {
  const rows = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`
  if (rows.length === 0) return
  const list = rows.map((r) => `"${r.tablename.replace(/"/g, '""')}"`).join(', ')
  // AuditLog неизменяем (триггер в БД): очистка демо-стенда — в одной транзакции с флагом обслуживания
  await db.$transaction([
    db.$executeRawUnsafe(`SELECT set_config('medflow.audit_maintenance', 'on', true)`),
    db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`),
  ])
}

// Сброс демо-стенда к исходным данным: кнопка администратора или ежедневный тик планировщика.
export async function POST(req: NextRequest) {
  const blocked = demoOnly()
  if (blocked) return blocked
  if (!isService(req)) {
    const g = await requireAuth(req)
    if (!g.ok) return g.res
    if (g.user.role !== 'ADMIN') return NextResponse.json({ error: 'Сброс доступен только администратору' }, { status: 403 })
  }
  const password = process.env.DEMO_PASSWORD
  if (!password) return NextResponse.json({ error: 'DEMO_PASSWORD не задан' }, { status: 500 })
  if (running) return NextResponse.json({ error: 'Сброс уже выполняется' }, { status: 409 })
  running = true
  const started = Date.now()
  try {
    await truncateAll()
    await seedDemo(db, { password, ssoIssuer: process.env.OIDC_ISSUER, log: () => undefined })
    return NextResponse.json({ ok: true, ms: Date.now() - started })
  } catch (e) {
    console.error('[demo/reset]', e)
    return NextResponse.json({ error: 'Не удалось сбросить демо-данные' }, { status: 500 })
  } finally {
    running = false
  }
}
