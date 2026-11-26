// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Ролевая модель доступа RBAC (РД-001..005) — общий модуль сервера и клиента

export type Role = 'ADMIN' | 'REGISTRAR' | 'DOCTOR' | 'MARKETER' | 'HEAD'

// Сквозные права: perm проверяется и на API, и в UI
export type Perm =
  | 'patients.read'
  | 'patients.create'
  | 'schedule.read'
  | 'appointments.create'
  | 'appointments.update'
  | 'waitinglist.read'
  | 'waitinglist.manage'
  | 'reminders.read'
  | 'reminders.manage'
  | 'notifications.read'
  | 'notifications.manage'
  | 'stock.read'
  | 'stock.manage'
  | 'integrations.read'
  | 'integrations.manage'
  | 'reports.read'
  | 'reports.schedule'
  | 'visits.read'
  | 'visits.write'
  | 'ai.protocol'
  | 'ai.summary'
  | 'cash.read'
  | 'cash.pay'
  | 'cash.fiscalize'
  | 'cash.refund'
  | 'cash.discount_override' // скидка сверх лимита роли и выдача кодов подтверждения кассиру
  | 'price.manage'
  | 'docs.read'
  | 'docs.sign'
  | 'sessions.read'
  | 'sessions.manage'
  | 'audit.read'
  | 'dashboard.read'
  | 'patients.read_basic' // обезличенный список для маркетинга: без ФИО, телефонов, e-mail
  | 'labs.create'
  | 'campaigns.manage'
  | 'settings.manage'
  | 'medical.read' // врачебная тайна: жалобы, протоколы, диагнозы, результаты анализов, AI-сводка
  | 'patients.manage' // правка карточки, отзыв согласия, обезличивание (152-ФЗ ст.14, 21)

const ALL_PERMS: Perm[] = [
  'patients.read',
  'patients.create',
  'schedule.read',
  'appointments.create',
  'appointments.update',
  'waitinglist.read',
  'waitinglist.manage',
  'reminders.read',
  'reminders.manage',
  'notifications.read',
  'notifications.manage',
  'stock.read',
  'stock.manage',
  'integrations.read',
  'integrations.manage',
  'reports.read',
  'reports.schedule',
  'visits.read',
  'visits.write',
  'ai.protocol',
  'ai.summary',
  'cash.read',
  'cash.pay',
  'cash.fiscalize',
  'cash.refund',
  'cash.discount_override',
  'price.manage',
  'docs.read',
  'docs.sign',
  'sessions.read',
  'sessions.manage',
  'audit.read',
  'dashboard.read',
  'patients.read_basic',
  'labs.create',
  'campaigns.manage',
  'settings.manage',
  'medical.read',
  'patients.manage',
]

// Единственная таблица прав: по ней работают и сервер (requirePerm), и клиент (hasPerm, меню).
// Принцип наименьших прав; матрица ролей — docs/ROLES.md (источник: ТЗ §4.5 + решение владельца):
//   Регистратор — запись и расписание, карточка пациента без медданных, касса/оплата.
//   Врач        — свои пациенты, своё расписание, медкарта (ЭМК).
//   Маркетолог  — кампании и агрегаты без персональных данных.
//   Руководитель— отчёты и дашборд (+ чтение аудита по ТЗ), без карт пациентов и касс.
//   Админ       — настройки, пользователи, интеграции; в ЭМК только чтение (запись приёма — врач).
const ADMIN_NOT: Perm[] = ['visits.write', 'ai.protocol', 'labs.create']

export const DEFAULT_ROLE_PERMS: Record<Role, Perm[]> = {
  ADMIN: ALL_PERMS.filter((p) => !ADMIN_NOT.includes(p)),
  REGISTRAR: [
    'patients.read', // карточка без медицинских полей (заметки, диагнозы — только medical.read)
    'patients.create',
    'schedule.read',
    'appointments.create',
    'appointments.update',
    'waitinglist.read',
    'waitinglist.manage',
    'reminders.read',
    'reminders.manage',
    'visits.read', // только цена/услуга/врач для кассы и справок, без медицинских полей и карточки пациента
    'cash.read',
    'cash.pay',
    'cash.fiscalize',
    'docs.read',
    'docs.sign',
  ],
  DOCTOR: [
    'patients.read', // только свои пациенты (DOCTOR_SCOPE=own)
    'schedule.read', // только своё расписание
    'visits.read',
    'visits.write',
    'ai.protocol',
    'ai.summary',
    'docs.read',
    'docs.sign',
    'labs.create',
    'medical.read',
  ],
  // Маркетолог не видит ПДн и медданные: обезличенный список, кампании, журнал рассылок с маскированием.
  MARKETER: ['patients.read_basic', 'notifications.read', 'reports.read', 'reports.schedule', 'dashboard.read', 'campaigns.manage'],
  // Руководитель: отчёты и дашборд. Без карт пациентов, касс, склада, интеграций, расписания.
  HEAD: ['reports.read', 'reports.schedule', 'dashboard.read', 'audit.read'],
}

export const ROLES: Role[] = ['ADMIN', 'REGISTRAR', 'DOCTOR', 'MARKETER', 'HEAD']
export const PERMS: readonly Perm[] = ALL_PERMS

// ---- Матрица в конфигурации клиники (чек-лист Тони, P2) ----
// RBAC_OVERRIDES='{"REGISTRAR":{"add":["reports.read"],"remove":["docs.sign"]}}' — клиника сама
// включает/выключает права ролям без правки кода. Применяется только на сервере (env не уходит
// в браузер); клиент получает итоговые perms и tabs из /api/auth/me — меню и API считаются
// по одной и той же матрице. Ограничители закона нельзя снять конфигом:
//   • врачебная тайна (323-ФЗ ст.13): medical.read, ai.* — только DOCTOR и ADMIN;
//   • маркетолог (152-ФЗ, минимизация): никаких прав на ПДн и медданные.
export type RbacOverrides = Partial<Record<Role, { add?: string[]; remove?: string[] }>>

const MEDICAL_PERMS: Perm[] = ['medical.read', 'ai.protocol', 'ai.summary', 'visits.write', 'labs.create']
const MEDICAL_ROLES: Role[] = ['DOCTOR', 'ADMIN']
const MARKETER_FORBIDDEN: Perm[] = ['patients.read', 'patients.create', 'patients.manage', 'visits.read', 'medical.read', 'integrations.read', 'integrations.manage', 'cash.read', 'docs.read', 'waitinglist.read', 'reminders.read', 'schedule.read', 'audit.read', 'sessions.read']

/** Разбор и проверка RBAC_OVERRIDES. Бросает Error с понятным текстом. */
export function parseRbacOverrides(raw: string | undefined | null): RbacOverrides {
  if (!raw || !raw.trim()) return {}
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    throw new Error('RBAC_OVERRIDES: некорректный JSON')
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('RBAC_OVERRIDES: ожидается объект {"РОЛЬ":{"add":[…],"remove":[…]}}')
  const out: RbacOverrides = {}
  for (const [role, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!ROLES.includes(role as Role)) throw new Error(`RBAC_OVERRIDES: неизвестная роль ${role}`)
    const o = (v || {}) as { add?: unknown; remove?: unknown }
    const list = (x: unknown, k: string): string[] => {
      if (x === undefined) return []
      if (!Array.isArray(x)) throw new Error(`RBAC_OVERRIDES.${role}.${k}: ожидается массив прав`)
      const bad = x.filter((p) => !ALL_PERMS.includes(p as Perm))
      if (bad.length) throw new Error(`RBAC_OVERRIDES.${role}.${k}: неизвестные права ${bad.join(', ')}`)
      return x as string[]
    }
    const add = list(o.add, 'add')
    const remove = list(o.remove, 'remove')
    const med = add.filter((p) => MEDICAL_PERMS.includes(p as Perm))
    if (med.length && !MEDICAL_ROLES.includes(role as Role)) throw new Error(`RBAC_OVERRIDES.${role}: права врачебной тайны (${med.join(', ')}) — только DOCTOR и ADMIN`)
    const mk = add.filter((p) => MARKETER_FORBIDDEN.includes(p as Perm))
    if (role === 'MARKETER' && mk.length) throw new Error(`RBAC_OVERRIDES.MARKETER: маркетологу нельзя выдать права на ПДн (${mk.join(', ')})`)
    if (role === 'ADMIN' && remove.includes('settings.manage')) throw new Error('RBAC_OVERRIDES.ADMIN: нельзя снять settings.manage у администратора')
    out[role as Role] = { add, remove }
  }
  return out
}

export function applyOverrides(base: Record<Role, Perm[]>, o: RbacOverrides): Record<Role, Perm[]> {
  const res = {} as Record<Role, Perm[]>
  for (const r of ROLES) {
    const set = new Set<Perm>(base[r])
    for (const p of o[r]?.add ?? []) set.add(p as Perm)
    for (const p of o[r]?.remove ?? []) set.delete(p as Perm)
    res[r] = ALL_PERMS.filter((p) => set.has(p))
  }
  return res
}

let cache: { raw: string | undefined; matrix: Record<Role, Perm[]> } | null = null
/** Итоговая матрица: значения по умолчанию + RBAC_OVERRIDES (только на сервере). */
export function roleMatrix(): Record<Role, Perm[]> {
  const raw = typeof process !== 'undefined' ? process.env.RBAC_OVERRIDES : undefined
  if (!cache || cache.raw !== raw) cache = { raw, matrix: applyOverrides(DEFAULT_ROLE_PERMS, parseRbacOverrides(raw)) }
  return cache.matrix
}

/** @deprecated для чтения матрицы используйте roleMatrix(); оставлено для совместимости */
export const ROLE_PERMS = DEFAULT_ROLE_PERMS

export function hasPerm(role: string, perm: Perm): boolean {
  const list = roleMatrix()[role as Role]
  return Boolean(list && list.includes(perm))
}

export function permsOf(role: string): Perm[] {
  return roleMatrix()[role as Role] || []
}

/** Проверка права на клиенте — по perms, которые прислал сервер (с учётом конфигурации клиники). */
export function can(me: Pick<Me, 'perms'> | null | undefined, perm: Perm): boolean {
  return Boolean(me && me.perms.includes(perm))
}

// ---- Вкладки интерфейса по роли ----

export type TabId = 'reg' | 'schedule' | 'waiting' | 'reminders' | 'notifications' | 'emk' | 'cash' | 'docs' | 'stock' | 'integrations' | 'reports' | 'widget' | 'dashboard' | 'sessions' | 'campaigns'

// Порядок вкладок и право (любое из списка), открывающее вкладку. Меню НЕ хранится по ролям:
// вкладки выводятся из ROLE_PERMS, поэтому сервер и клиент не могут разойтись.
export const TAB_PERMS: Array<{ id: TabId; any: Perm[] }> = [
  { id: 'reg', any: ['appointments.create'] },
  { id: 'schedule', any: ['schedule.read'] },
  { id: 'waiting', any: ['waitinglist.read'] },
  { id: 'reminders', any: ['reminders.read'] },
  { id: 'notifications', any: ['notifications.read'] },
  { id: 'emk', any: ['medical.read'] },
  { id: 'cash', any: ['cash.read'] },
  { id: 'docs', any: ['docs.read'] },
  { id: 'stock', any: ['stock.read'] },
  { id: 'integrations', any: ['integrations.read'] },
  { id: 'reports', any: ['reports.read'] },
  { id: 'widget', any: ['settings.manage'] },
  { id: 'dashboard', any: ['dashboard.read'] },
  { id: 'sessions', any: ['sessions.read', 'audit.read'] },
  { id: 'campaigns', any: ['campaigns.manage'] },
]

export function tabsOf(role: string): TabId[] {
  return tabsForPerms(permsOf(role))
}

/** Вкладки по perms (например, присланным сервером). */
export function tabsForPerms(perms: readonly Perm[]): TabId[] {
  return TAB_PERMS.filter((t) => t.any.some((p) => perms.includes(p))).map((t) => t.id)
}

// Текущий пользователь на клиенте
export interface Me {
  id: string
  login: string
  name: string
  role: Role
  perms: Perm[]
  tabs: TabId[]
  doctorId?: string | null
  clinicTz?: string
  mode?: 'production' | 'demo'
  totpEnabled?: boolean
}
