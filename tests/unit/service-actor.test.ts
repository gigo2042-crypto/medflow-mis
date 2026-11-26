// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Чек-лист P2: requireServiceOrPerm — отдельный тип «служебный вызов» вместо синтетического ADMIN.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { actorId, actorMeta, requireServiceOrPerm } from '@/lib/auth-server'

const KEY = 'svc-test-key-' + 'x'.repeat(24)
beforeAll(() => {
  process.env.SERVICE_KEY = KEY
})
const req = (h: Record<string, string> = {}) => new NextRequest('http://localhost/api/reminders', { method: 'POST', headers: h })

describe('служебный вызов', () => {
  it('верный x-service-key → ServiceActor без пользователя и роли', async () => {
    const g = await requireServiceOrPerm(req({ 'x-service-key': KEY }), 'reminders.manage')
    expect(g.ok).toBe(true)
    if (!g.ok) return
    expect(g.user).toBeNull()
    expect(g.service).toEqual({ kind: 'service', name: 'scheduler' })
    expect(JSON.stringify(g)).not.toContain('ADMIN')
    expect(actorId(g)).toBeNull()
    expect(actorMeta(g)).toEqual({ actor: 'service' })
  })
  it('неверный ключ и без cookie → 401 (не служебный и не пользователь)', async () => {
    const g = await requireServiceOrPerm(req({ 'x-service-key': KEY + 'y' }), 'reminders.manage')
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.res.status).toBe(401)
  })
  it('в коде нет синтетического пользователя с ролью ADMIN', () => {
    const src = readFileSync('src/lib/auth-server.ts', 'utf8')
    expect(src).not.toMatch(/role:\s*'ADMIN'/)
    expect(src).not.toContain('scheduler-service')
  })
  // обращение к g.user.* без проверки на null дополнительно ловит tsc (ServiceOrUserGuard: user | null)
  it('маршруты-воркеры пишут аудит через actorId (служебный вызов — без userId)', () => {
    for (const f of ['integrations/route.ts', 'integrations/1c/route.ts', 'reminders/route.ts', 'payments/fiscal/route.ts', 'notifications/route.ts']) {
      const src = readFileSync('src/app/api/' + f, 'utf8')
      expect(src, f).toContain('requireServiceOrPerm')
      expect(src, f).toContain('actorId(g)')
    }
  })
})

describe('P2: имя и версия пакета', () => {
  it('package.json и lock: medflow 0.3.0; версия идёт в метрики/отчёты', async () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
    expect(pkg.name).toBe('medflow')
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect([lock.name, lock.version, lock.packages[''].name, lock.packages[''].version]).toEqual([pkg.name, pkg.version, pkg.name, pkg.version])
    const { APP_VERSION } = await import('@/lib/version')
    expect(APP_VERSION).toBe(process.env.MEDFLOW_VERSION || pkg.version)
  })
})
