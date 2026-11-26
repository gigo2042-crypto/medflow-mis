// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Матрица прав (чек-лист Тони, P0/P2): одна таблица для меню и API, наименьшие права,
// переопределение в конфигурации клиники с ограничителями закона.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyOverrides, DEFAULT_ROLE_PERMS, parseRbacOverrides, permsOf, PERMS, ROLES, TAB_PERMS, tabsForPerms, tabsOf } from '@/lib/rbac'

const EXPECTED_TABS: Record<string, string[]> = {
  ADMIN: ['reg', 'schedule', 'waiting', 'reminders', 'notifications', 'emk', 'cash', 'docs', 'stock', 'integrations', 'reports', 'widget', 'dashboard', 'sessions', 'campaigns'],
  REGISTRAR: ['reg', 'schedule', 'waiting', 'reminders', 'cash', 'docs'],
  DOCTOR: ['schedule', 'emk', 'docs'],
  MARKETER: ['notifications', 'reports', 'dashboard', 'campaigns'],
  HEAD: ['reports', 'dashboard', 'sessions'],
}

afterEach(() => {
  delete process.env.RBAC_OVERRIDES
})

describe('матрица по умолчанию', () => {
  it('вкладки каждой роли — эталон', () => {
    for (const r of ROLES) expect(tabsOf(r), r).toEqual(EXPECTED_TABS[r])
  })
  it('регистратор: нет интеграций, склада, обезличивания карточек, ЭМК, виджета, медданных; правку контактов и согласий делает', () => {
    const p = permsOf('REGISTRAR')
    for (const x of ['integrations.read', 'integrations.manage', 'stock.read', 'stock.manage', 'patients.manage', 'medical.read', 'visits.write', 'settings.manage', 'reports.read', 'dashboard.read', 'notifications.read'] as const) expect(p, x).not.toContain(x)
    for (const t of ['emk', 'stock', 'integrations', 'widget']) expect(tabsOf('REGISTRAR')).not.toContain(t)
    for (const x of ['schedule.read', 'appointments.create', 'patients.read', 'patients.edit', 'cash.pay'] as const) expect(p).toContain(x)
    // обезличивание (необратимо) — только администратор
    expect(permsOf('ADMIN')).toContain('patients.manage')
    for (const r of ['DOCTOR', 'MARKETER', 'HEAD']) expect(permsOf(r), r).not.toContain('patients.edit')
  })
  it('маркетолог и руководитель — без ПДн и медданных', () => {
    for (const r of ['MARKETER', 'HEAD']) for (const x of ['patients.read', 'medical.read', 'visits.read', 'cash.read', 'integrations.read'] as const) expect(permsOf(r), `${r} ${x}`).not.toContain(x)
  })
  it('медицинские права — только врач и администратор (у админа в ЭМК только чтение)', () => {
    for (const r of ROLES) {
      const has = permsOf(r).includes('medical.read')
      expect(has, r).toBe(r === 'DOCTOR' || r === 'ADMIN')
    }
    expect(permsOf('ADMIN')).not.toContain('visits.write')
  })
  it('меню выводится из прав: вкладка есть ⇔ есть право вкладки', () => {
    for (const r of ROLES) expect(tabsOf(r)).toEqual(tabsForPerms(permsOf(r)))
    for (const t of TAB_PERMS) for (const p of t.any) expect(PERMS).toContain(p)
  })
  it('все права в requirePerm/requireServiceOrPerm маршрутов существуют в матрице', () => {
    const files: string[] = []
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : f === 'route.ts' && files.push(p) } }
    walk('src/app/api')
    const used = new Set<string>()
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/require(?:Perm|ServiceOrPerm)\(req, '([a-z_.]+)'\)/g)) used.add(m[1])
    expect(used.size).toBeGreaterThan(20)
    for (const p of used) expect(PERMS, p).toContain(p)
  })
})

describe('матрица в конфигурации (RBAC_OVERRIDES)', () => {
  it('клиника включает регистратору отчёты и выключает подпись документов — меню и права меняются вместе', () => {
    process.env.RBAC_OVERRIDES = JSON.stringify({ REGISTRAR: { add: ['reports.read'], remove: ['docs.read', 'docs.sign'] } })
    expect(permsOf('REGISTRAR')).toContain('reports.read')
    expect(tabsOf('REGISTRAR')).toContain('reports')
    expect(tabsOf('REGISTRAR')).not.toContain('docs')
  })
  it('без переопределения — значения по умолчанию', () => {
    expect(applyOverrides(DEFAULT_ROLE_PERMS, {})).toEqual(Object.fromEntries(ROLES.map((r) => [r, PERMS.filter((p) => DEFAULT_ROLE_PERMS[r].includes(p))])))
  })
  it('ограничители: медданные не-врачу, ПДн маркетологу, неизвестные права и роли, битый JSON — ошибка', () => {
    expect(() => parseRbacOverrides('{"REGISTRAR":{"add":["medical.read"]}}')).toThrow(/врачебной тайны/)
    expect(() => parseRbacOverrides('{"HEAD":{"add":["ai.summary"]}}')).toThrow(/врачебной тайны/)
    expect(() => parseRbacOverrides('{"MARKETER":{"add":["patients.read"]}}')).toThrow(/маркетологу/)
    expect(() => parseRbacOverrides('{"REGISTRAR":{"add":["root"]}}')).toThrow(/неизвестные права/)
    expect(() => parseRbacOverrides('{"GOD":{}}')).toThrow(/неизвестная роль/)
    expect(() => parseRbacOverrides('{oops')).toThrow(/JSON/)
    expect(() => parseRbacOverrides('{"ADMIN":{"remove":["settings.manage"]}}')).toThrow(/settings.manage/)
  })
})
