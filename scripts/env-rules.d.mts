// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
export function appModeOf(env: Record<string, string | undefined>): 'production' | 'demo'
export function validateEnv(env: Record<string, string | undefined>): string[]
export declare const CLINIC_REQUIRED: string[]
export declare function clinicRequisitesFrom(env: Record<string, string | undefined>): {
  configured: boolean
  missing: string[]
  demo: boolean
  name: string
  shortName: string
  inn: string
  ogrn: string
  address: string
  phone: string
  license: string
}
export declare function envWarnings(env: Record<string, string | undefined>): string[]
export declare function isLocalLlmUrl(url: string | undefined): boolean
export declare function llmIsExternal(env?: Record<string, string | undefined>): boolean
export declare function llmExternalAllowed(env?: Record<string, string | undefined>): boolean
