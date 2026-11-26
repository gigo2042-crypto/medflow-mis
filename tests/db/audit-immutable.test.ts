// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Чек-лист P1: журнал аудита неизменяем на уровне БД (триггер), и код МИС журнал не меняет.
import { beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { authed, resetDb, staffSession, useTestDb } from './helpers'

useTestDb()
let db: Awaited<ReturnType<typeof resetDb>>
beforeEach(async () => {
  db = await resetDb()
})

describe('AuditLog неизменяем', () => {
  it('INSERT работает; UPDATE, DELETE, TRUNCATE и удаление сотрудника с записями аудита — отказ', async () => {
    const { audit } = await import('@/lib/auth-server')
    const u = await staffSession(db, 'ADMIN')
    await audit('test.event', u.user.id, { x: 1 })
    const row = await db.auditLog.findFirstOrThrow({ where: { action: 'test.event' } })
    await expect(db.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } })).rejects.toThrow(/неизменяем/)
    await expect(db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/неизменяем/)
    await expect(db.$executeRawUnsafe('DELETE FROM "AuditLog"')).rejects.toThrow(/неизменяем/)
    await expect(db.$executeRawUnsafe('TRUNCATE "AuditLog"')).rejects.toThrow(/неизменяем/)
    await db.authSession.deleteMany({ where: { userId: u.user.id } })
    await expect(db.staffUser.delete({ where: { id: u.user.id } })).rejects.toThrow() // ON DELETE SET NULL = UPDATE журнала
    expect((await db.auditLog.findUniqueOrThrow({ where: { id: row.id } })).action).toBe('test.event')
  })
  it('флаг обслуживания действует только внутри своей транзакции', async () => {
    await db.auditLog.create({ data: { action: 'test.keep' } })
    await db.$transaction([db.$executeRawUnsafe(`SELECT set_config('medflow.audit_maintenance', 'on', true)`), db.$executeRawUnsafe('SELECT 1')])
    await expect(db.$executeRawUnsafe('DELETE FROM "AuditLog"')).rejects.toThrow(/неизменяем/)
    expect(await db.auditLog.count()).toBe(1)
  })
})

describe('сотрудника отключают, а не удаляют', () => {
  it('cli deactivate: active=false, сессии завершены, API — 401, в аудите запись; activate возвращает доступ', async () => {
    const { audit } = await import('@/lib/auth-server')
    const u = await staffSession(db, 'REGISTRAR')
    await audit('test.event', u.user.id)
    const { GET } = await import('@/app/api/auth/me/route')
    expect((await GET(await authed(u.cookie, 'GET', '/api/auth/me'))).status).toBe(200)
    const cli = (...a: string[]) => execFileSync('npx', ['tsx', 'scripts/cli.ts', ...a], { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, stdio: 'pipe' }).toString()
    expect(cli('deactivate', '--login', u.user.login, '--reason', 'тест')).toContain('отключён')
    expect((await db.staffUser.findUniqueOrThrow({ where: { id: u.user.id } })).active).toBe(false)
    expect(await db.authSession.count({ where: { userId: u.user.id } })).toBe(0)
    expect((await GET(await authed(u.cookie, 'GET', '/api/auth/me'))).status).toBe(401)
    expect(await db.auditLog.count({ where: { action: 'user.deactivated' } })).toBe(1)
    expect(await db.auditLog.count({ where: { userId: u.user.id } })).toBe(1) // прежние записи на месте
    cli('activate', '--login', u.user.login)
    expect((await db.staffUser.findUniqueOrThrow({ where: { id: u.user.id } })).active).toBe(true)
  }, 60_000)
})

describe('код МИС не изменяет и не удаляет записи аудита', () => {
  it('в src/ и scripts/ нет update/delete/upsert для AuditLog (кроме сброса демо)', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx|mjs|js)$/.test(f)) files.push(p)
      }
    }
    walk('src')
    walk('scripts')
    const bad: string[] = []
    for (const f of files) {
      const t = readFileSync(f, 'utf8')
      const hits = t.match(/auditLog\.(update|updateMany|delete|deleteMany|upsert)\b|(UPDATE|DELETE FROM|TRUNCATE)\s+"?AuditLog"?/g) ?? []
      for (const h of hits) if (!(f.endsWith(join('demo', 'seed.ts')) && h === 'auditLog.deleteMany')) bad.push(`${f}: ${h}`)
    }
    expect(bad).toEqual([])
  })
})
