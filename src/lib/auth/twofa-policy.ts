// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Политика второго фактора (чек-лист Тони, P0): 2FA обязательна всем ролям с доступом к ПДн.
// По умолчанию — все роли, кроме MARKETER (у маркетолога только обезличенные данные).
// TWO_FA_ROLES переопределяет список; OIDC_MFA_ROLES по умолчанию равен TWO_FA_ROLES —
// вход по паролю и через SSO подчиняются одной политике.
export const PD_ROLES = ['ADMIN', 'REGISTRAR', 'DOCTOR', 'HEAD'] as const
export const DEFAULT_TWO_FA_ROLES: readonly string[] = PD_ROLES

function parse(raw: string | undefined): string[] | null {
  if (!raw || !raw.trim()) return null
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
}

export function twoFaRoles(env: Record<string, string | undefined> = process.env): string[] {
  return parse(env.TWO_FA_ROLES) ?? [...DEFAULT_TWO_FA_ROLES]
}

/** Роли, для которых при входе через SSO IdP обязан подтвердить MFA (amr/acr). */
export function oidcMfaRoles(env: Record<string, string | undefined> = process.env): string[] {
  return parse(env.OIDC_MFA_ROLES) ?? twoFaRoles(env)
}
