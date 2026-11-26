// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { cascadeRules } from '@/lib/reminders'

export const dynamic = 'force-dynamic'

// Правила каскада напоминаний (вместо хардкода 48/24/3, чеклист п.14)
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'reminders.read')
  if (!g.ok) return g.res
  await cascadeRules() // создаёт правила по умолчанию при пустой таблице
  const rules = await db.reminderRule.findMany({ orderBy: { level: 'asc' } })
  return NextResponse.json({ rules: rules.map((r) => ({ level: r.level, hours: r.hours, active: r.active })) })
}

export async function PUT(req: NextRequest) {
  const g = await requirePerm(req, 'reminders.manage')
  if (!g.ok) return g.res
  try {
    const body = await req.json()
    const rules = Array.isArray(body.rules) ? body.rules : null
    if (!rules || rules.length === 0 || rules.length > 5) {
      return NextResponse.json({ error: 'Задайте от 1 до 5 уровней каскада' }, { status: 400 })
    }
    const clean = rules.map((r: { hours: unknown; active?: unknown }, i: number) => ({
      level: i + 1,
      hours: Math.round(Number(r.hours)),
      active: r.active === undefined ? true : Boolean(r.active),
    }))
    if (clean.some((r: { hours: number }) => !Number.isFinite(r.hours) || r.hours < 1 || r.hours > 24 * 14)) {
      return NextResponse.json({ error: 'Часы до приёма — от 1 до 336' }, { status: 400 })
    }
    for (let i = 1; i < clean.length; i++) {
      if (clean[i].hours >= clean[i - 1].hours) {
        return NextResponse.json({ error: 'Каждый следующий уровень должен быть ближе к приёму' }, { status: 400 })
      }
    }
    await db.$transaction([
      db.reminderRule.deleteMany({ where: { level: { gt: clean.length } } }),
      ...clean.map((r: { level: number; hours: number; active: boolean }) =>
        db.reminderRule.upsert({ where: { level: r.level }, update: { hours: r.hours, active: r.active }, create: r })
      ),
    ])
    await audit('reminders.rules_updated', g.user.id, { rules: clean })
    return NextResponse.json({ ok: true, rules: clean })
  } catch (e) {
    console.error('[reminder-rules PUT]', e)
    return NextResponse.json({ error: 'Не удалось сохранить правила' }, { status: 500 })
  }
}
