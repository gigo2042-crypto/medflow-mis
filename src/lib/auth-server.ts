// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Серверные утилиты аутентификации и RBAC (РД-015..020, ФТ-039)
// Не импортировать в клиентский код!

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, timingSafeEqual, createHmac } from 'crypto'
import { db } from '@/lib/db'
import { hasPerm, Perm, Role } from '@/lib/rbac'
import { requiredEnv, secureCookies } from '@/lib/config'

export const SESSION_COOKIE = 'medflow_session'
const SESSION_HOURS = 8 // рабочая смена

export { hashPassword, verifyPassword, passwordProblem } from '@/lib/password'

export interface AuthUser {
  id: string
  login: string
  name: string
  role: Role
  doctorId: string | null
  sessionId: string
}

// Текущий пользователь по httpOnly-cookie с сессией в БД
export async function getSessionUser(req: NextRequest): Promise<AuthUser | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (!token) return null
  const session = await db.authSession.findUnique({ where: { id: hashToken(token) }, include: { user: true } })
  if (!session) return null
  if (session.expiresAt.getTime() < Date.now()) {
    await db.authSession.delete({ where: { id: session.id } }).catch(() => undefined)
    return null
  }
  if (!session.user.active) return null
  return {
    id: session.user.id,
    login: session.user.login,
    name: session.user.name,
    role: session.user.role as Role,
    doctorId: session.user.doctorId ?? null,
    sessionId: session.id,
  }
}

type Guard = { ok: true; user: AuthUser } | { ok: false; res: NextResponse }

// Служебные вызовы планировщика и мини-сервисов: ключ x-service-key только из env,
// без значения по умолчанию (в отсутствие SERVICE_KEY приложение не стартует)
function serviceKey(): string {
  return requiredEnv('SERVICE_KEY')
}

export function isService(req: NextRequest): boolean {
  const got = req.headers.get('x-service-key')
  if (!got) return false
  const a = Buffer.from(got)
  const b = Buffer.from(serviceKey())
  return a.length === b.length && timingSafeEqual(a, b)
}

type ServiceGuard = { ok: true } | { ok: false; res: NextResponse }

export function requireService(req: NextRequest): ServiceGuard {
  if (!isService(req)) {
    return { ok: false, res: NextResponse.json({ error: 'Служебный вызов: неверный x-service-key' }, { status: 401 }) }
  }
  return { ok: true }
}

/** Служебный вызов (планировщик, воркеры по x-service-key): не пользователь и не роль. */
export interface ServiceActor {
  kind: 'service'
  name: 'scheduler'
}

export type ServiceOrUserGuard =
  | { ok: true; user: AuthUser; service: null }
  | { ok: true; user: null; service: ServiceActor }
  | { ok: false; res: NextResponse }

// Ключ сервиса ИЛИ cookie-сессия с правом (воркеры, которые можно дёргать и из интерфейса).
// Служебный вызов — отдельный тип ServiceActor: у него нет роли и прав пользователя, маршрут
// разрешает ему только запуск своего воркера. В аудит пишется без userId, с actor: 'service'.
export async function requireServiceOrPerm(req: NextRequest, perm: Perm): Promise<ServiceOrUserGuard> {
  if (isService(req)) return { ok: true, user: null, service: { kind: 'service', name: 'scheduler' } }
  const g = await requirePerm(req, perm)
  return g.ok ? { ok: true, user: g.user, service: null } : g
}

/** id пользователя для аудита; null — служебный вызов. */
export function actorId(g: { user: AuthUser | null }): string | null {
  return g.user?.id ?? null
}

/** Метка служебного вызова для meta аудита. */
export function actorMeta(g: { user: AuthUser | null }): Record<string, unknown> {
  return g.user ? {} : { actor: 'service' }
}

// 401 — не выполнен вход
export async function requireAuth(req: NextRequest): Promise<Guard> {
  const user = await getSessionUser(req)
  if (!user) return { ok: false, res: NextResponse.json({ error: 'Требуется вход в систему' }, { status: 401 }) }
  return { ok: true, user }
}

// 403 — роль не имеет права (РД-001: матрица «роль — модуль — действие»)
export async function requirePerm(req: NextRequest, perm: Perm): Promise<Guard> {
  const user = await getSessionUser(req)
  if (!user) return { ok: false, res: NextResponse.json({ error: 'Требуется вход в систему' }, { status: 401 }) }
  if (!hasPerm(user.role, perm)) {
    return { ok: false, res: NextResponse.json({ error: `Недостаточно прав: ${perm}` }, { status: 403 }) }
  }
  return { ok: true, user }
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

// В БД хранится не сам токен, а его HMAC: утечка таблицы сессий не даёт войти
export function hashToken(token: string): string {
  return createHmac('sha256', requiredEnv('SESSION_SECRET')).update(token).digest('hex')
}

export async function createAuthSession(userId: string): Promise<string> {
  const token = newSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000)
  await db.authSession.create({ data: { id: hashToken(token), userId, expiresAt } })
  return token
}

export function setSessionCookie(res: NextResponse, token: string): NextResponse {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_HOURS * 3600,
  })
  return res
}

export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, secure: secureCookies(), sameSite: 'lax', path: '/', maxAge: 0 })
  return res
}

// Ключи метаданных аудита, которые нельзя писать в журнал (ПДн пациентов)
const PII_KEYS = new Set(['name', 'patient', 'patientName', 'fio', 'phone', 'email', 'birthDate'])

// Append-only аудит (ФТ-039, АРХ-013): best-effort, не ломает основной поток.
// ФИО/телефоны в журнал не пишутся — только идентификаторы.
export async function audit(action: string, userId: string | null, meta?: Record<string, unknown>): Promise<void> {
  try {
    let clean: Record<string, unknown> | undefined
    if (meta) {
      clean = {}
      for (const [k, v] of Object.entries(meta)) if (!PII_KEYS.has(k)) clean[k] = v
    }
    const uid = userId || undefined
    await db.auditLog.create({
      data: { action, userId: uid, meta: clean ? JSON.stringify(clean) : null },
    })
  } catch (e) {
    console.error('[audit]', e)
  }
}
