// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Единый вход через любой OpenID Connect-провайдер (Keycloak, Яндекс 360 / ID,
// Azure AD, ADFS, Authentik…): authorization code flow + PKCE (S256), state и nonce
// в подписанной httpOnly-куке, сопоставление групп IdP с ролями МИС.
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'crypto'
import { Role } from '@/lib/rbac'
import { appUrl, requiredEnv } from '@/lib/config'

export const OIDC_COOKIE = 'medflow_oidc'
export const OIDC_COOKIE_TTL_SEC = 600

export interface OidcDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  jwks_uri?: string
}

export type Jwk = { kty?: string; kid?: string; alg?: string; use?: string; [k: string]: unknown }

let jwksCache: { at: number; uri: string; keys: Jwk[] } | null = null

/** Ключи подписи IdP (для RS256/ES256/PS256), кэш 10 минут. */
export async function fetchJwks(uri: string): Promise<Jwk[]> {
  if (jwksCache && jwksCache.uri === uri && Date.now() - jwksCache.at < 10 * 60_000) return jwksCache.keys
  const res = await fetch(uri, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`OIDC JWKS: HTTP ${res.status}`)
  const j = (await res.json()) as { keys?: Jwk[] }
  const keys = Array.isArray(j.keys) ? j.keys : []
  jwksCache = { at: Date.now(), uri, keys }
  return keys
}

export function idTokenAlg(idToken: string): string {
  try {
    return String((JSON.parse(Buffer.from(idToken.split('.')[0], 'base64url').toString('utf8')) as { alg?: string }).alg || '')
  } catch {
    return ''
  }
}

const ASYM: Record<string, { hash: string; opts?: Record<string, unknown> }> = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', opts: { padding: 6, saltLength: 32 } }, // RSA_PKCS1_PSS_PADDING
  ES256: { hash: 'sha256', opts: { dsaEncoding: 'ieee-p1363' } },
  ES384: { hash: 'sha384', opts: { dsaEncoding: 'ieee-p1363' } },
}

export function oidcEnabled(): boolean {
  return Boolean(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET)
}

export function redirectUri(): string {
  return `${appUrl()}/api/auth/oidc/callback`
}

let discoveryCache: { at: number; doc: OidcDiscovery } | null = null

export async function discover(): Promise<OidcDiscovery> {
  if (discoveryCache && Date.now() - discoveryCache.at < 10 * 60_000) return discoveryCache.doc
  const issuer = requiredEnv('OIDC_ISSUER').replace(/\/+$/, '')
  const url = process.env.OIDC_DISCOVERY_URL || `${issuer}/.well-known/openid-configuration`
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`OIDC discovery: HTTP ${res.status}`)
  const doc = (await res.json()) as OidcDiscovery
  if (!doc.authorization_endpoint || !doc.token_endpoint) throw new Error('OIDC discovery: нет endpoint-ов')
  if (doc.issuer.replace(/\/+$/, '') !== issuer) throw new Error('OIDC discovery: issuer не совпадает с OIDC_ISSUER')
  discoveryCache = { at: Date.now(), doc }
  return doc
}

export function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export interface OidcFlowState {
  state: string
  nonce: string
  verifier: string
  exp: number
}

function sign(data: string): string {
  return createHmac('sha256', requiredEnv('SESSION_SECRET')).update(`oidc:${data}`).digest('base64url')
}

export function encodeFlowCookie(s: OidcFlowState): string {
  const data = b64url(Buffer.from(JSON.stringify(s)))
  return `${data}.${sign(data)}`
}

export function decodeFlowCookie(v: string | undefined): OidcFlowState | null {
  if (!v || !v.includes('.')) return null
  const [data, sig] = v.split('.')
  const expected = sign(data)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const s = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as OidcFlowState
    if (!s.state || !s.nonce || !s.verifier || s.exp < Date.now()) return null
    return s
  } catch {
    return null
  }
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a || '')
  const y = Buffer.from(b || '')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

export interface IdTokenClaims {
  iss: string
  sub: string
  aud: string | string[]
  exp: number
  iat?: number
  nonce?: string
  email?: string
  name?: string
  preferred_username?: string
  amr?: string[]
  acr?: string
  [k: string]: unknown
}

/**
 * Проверка id_token. Токен получен сервером напрямую от token_endpoint по TLS
 * (OIDC Core 3.1.3.7, п.6), поэтому для RS256/ES256 достаточно проверки TLS;
 * для HS256 дополнительно проверяется подпись секретом клиента.
 */
export function verifyIdToken(
  idToken: string,
  expected: { issuer: string; clientId: string; nonce: string; clientSecret: string; jwks?: Jwk[] }
): IdTokenClaims {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('id_token: неверный формат')
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: string; kid?: string }
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as IdTokenClaims
  if (header.alg === 'none' || !header.alg) throw new Error('id_token: alg=none запрещён')
  if (header.alg === 'HS256') {
    const sig = createHmac('sha256', expected.clientSecret).update(`${parts[0]}.${parts[1]}`).digest('base64url')
    if (!safeEqual(sig, parts[2])) throw new Error('id_token: неверная подпись')
  } else if (ASYM[header.alg]) {
    const candidates = (expected.jwks || []).filter((k) => (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig'))
    if (!candidates.length) throw new Error('id_token: ключ подписи не найден в JWKS')
    const { hash, opts } = ASYM[header.alg]
    const data = Buffer.from(`${parts[0]}.${parts[1]}`)
    const sig = Buffer.from(parts[2], 'base64url')
    const ok = candidates.some((jwk) => {
      try {
        const key = createPublicKey({ key: jwk, format: 'jwk' } as Parameters<typeof createPublicKey>[0])
        return cryptoVerify(hash, data, opts ? { key, ...opts } : key, sig)
      } catch {
        return false
      }
    })
    if (!ok) throw new Error('id_token: неверная подпись')
  } else {
    throw new Error(`id_token: алгоритм ${header.alg} не поддерживается`)
  }
  if (String(claims.iss).replace(/\/+$/, '') !== expected.issuer.replace(/\/+$/, '')) throw new Error('id_token: чужой issuer')
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(expected.clientId)) throw new Error('id_token: чужая audience')
  if (!claims.exp || claims.exp * 1000 < Date.now() - 60_000) throw new Error('id_token: истёк')
  if (!claims.nonce || !safeEqual(claims.nonce, expected.nonce)) throw new Error('id_token: nonce не совпал')
  if (!claims.sub) throw new Error('id_token: нет sub')
  return claims
}

const ROLE_PRIORITY: Role[] = ['ADMIN', 'HEAD', 'DOCTOR', 'REGISTRAR', 'MARKETER']

/** OIDC_ROLE_MAP="mis-admins=ADMIN,mis-doctors=DOCTOR" → роль по группам (старшая из совпавших). */
export function mapGroupsToRole(groups: string[], mapSpec: string): Role | null {
  const map = new Map<string, Role>()
  for (const pair of mapSpec.split(',')) {
    const [g, r] = pair.split('=').map((s) => s.trim())
    if (g && r && (ROLE_PRIORITY as string[]).includes(r.toUpperCase())) map.set(g, r.toUpperCase() as Role)
  }
  const roles = new Set<Role>()
  for (const g of groups) {
    // Keycloak отдаёт полные пути групп ("/mis-admins") — допускаем оба вида
    const r = map.get(g) ?? map.get(g.replace(/^\/+/, ''))
    if (r) roles.add(r)
  }
  for (const r of ROLE_PRIORITY) if (roles.has(r)) return r
  return null
}

export function groupsFrom(claims: Record<string, unknown>, claimName: string): string[] {
  const v = claims[claimName]
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean)
  return []
}

// sms не считается сильным вторым фактором (перехват/SIM-swap) — не принимается как MFA
const MFA_AMR = ['mfa', 'otp', 'hwk', 'swk', 'fpt', 'face', 'pop']

/** Прошёл ли пользователь второй фактор на стороне IdP (amr/acr). */
export function hasMfa(claims: IdTokenClaims): boolean {
  if (Array.isArray(claims.amr) && claims.amr.some((a) => MFA_AMR.includes(String(a).toLowerCase()))) return true
  const acr = process.env.OIDC_MFA_ACR
  if (acr && claims.acr && acr.split(',').map((s) => s.trim()).includes(claims.acr)) return true
  return false
}
