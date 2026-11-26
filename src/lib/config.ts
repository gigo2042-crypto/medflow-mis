// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Конфигурация приложения: режим APP_MODE=production|demo и проверка env.
// В production без обязательных секретов приложение не стартует (instrumentation.ts).
import { appModeOf, validateEnv } from '../../scripts/env-rules.mjs'
import { parseRbacOverrides } from './rbac'

export type AppMode = 'production' | 'demo'

export function appMode(): AppMode {
  return appModeOf(process.env)
}

export function isDemo(): boolean {
  return appMode() === 'demo'
}

export function isProduction(): boolean {
  return appMode() === 'production'
}

/** Часовой пояс клиники: все времена приёмов показываются и считаются в нём. */
export function clinicTz(): string {
  return process.env.CLINIC_TZ || 'Europe/Moscow'
}

export function assertConfig(): void {
  const errors = validateEnv(process.env)
  try {
    parseRbacOverrides(process.env.RBAC_OVERRIDES)
  } catch (e) {
    errors.push((e as Error).message)
  }
  if (errors.length) {
    throw new Error(`[medflow] Конфигурация (${appMode()}) невалидна:\n - ${errors.join('\n - ')}`)
  }
}

/** Значение секрета без дефолтов: при отсутствии — исключение. */
export function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`[medflow] Не задана переменная окружения ${name}`)
  return v
}

/** Публичный адрес приложения (для redirect_uri OIDC и ссылок в письмах). */
export function appUrl(): string {
  return requiredEnv('APP_URL').replace(/\/+$/, '')
}

/** Кука сессии Secure: всегда, кроме явно разрешённого http для локальной проверки. */
export function secureCookies(): boolean {
  return process.env.ALLOW_INSECURE_HTTP !== '1'
}
