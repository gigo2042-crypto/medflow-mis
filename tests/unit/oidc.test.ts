// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { describe, expect, it } from 'vitest'
import { createHmac, generateKeyPairSync, sign } from 'crypto'
import { decodeFlowCookie, encodeFlowCookie, groupsFrom, hasMfa, mapGroupsToRole, pkcePair, verifyIdToken } from '@/lib/oidc'

process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefgh'
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const now = () => Math.floor(Date.now() / 1000)
const base = { iss: 'https://idp.test', aud: 'medflow', sub: 'u1', nonce: 'n1', exp: now() + 300 }
const exp = { issuer: 'https://idp.test', clientId: 'medflow', nonce: 'n1', clientSecret: 'fake-client-secret-123' }
function hs(claims: object, secret = exp.clientSecret) {
  const h = b64({ alg: 'HS256', typ: 'JWT' })
  const p = b64(claims)
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`
}

describe('OIDC', () => {
  it('PKCE S256: challenge = base64url(sha256(verifier))', async () => {
    const { verifier, challenge } = pkcePair()
    const { createHash } = await import('crypto')
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(verifier.length).toBeGreaterThanOrEqual(43)
  })
  it('flow-кука подписана: подмена отвергается', () => {
    const c = encodeFlowCookie({ state: 's', nonce: 'n', verifier: 'v', exp: Date.now() + 60_000 })
    expect(decodeFlowCookie(c)?.state).toBe('s')
    const [body, sig] = c.split('.')
    const forged = Buffer.from(JSON.stringify({ state: 'evil', nonce: 'n', verifier: 'v', exp: Date.now() + 60_000 })).toString('base64url')
    expect(decodeFlowCookie(`${forged}.${sig}`)).toBeNull()
    expect(decodeFlowCookie(`${body}.AAAA`)).toBeNull()
    expect(decodeFlowCookie(undefined)).toBeNull()
  })
  it('id_token HS256: валидный принимается', () => {
    expect(verifyIdToken(hs(base), exp).sub).toBe('u1')
  })
  it('id_token: alg=none, чужая подпись, issuer, aud, nonce, exp — отвергаются', () => {
    const none = `${b64({ alg: 'none' })}.${b64(base)}.`
    expect(() => verifyIdToken(none, exp)).toThrow()
    expect(() => verifyIdToken(hs(base, 'other-secret'), exp)).toThrow(/подпись/)
    expect(() => verifyIdToken(hs({ ...base, iss: 'https://evil' }), exp)).toThrow(/issuer/)
    expect(() => verifyIdToken(hs({ ...base, aud: 'other' }), exp)).toThrow(/audience/)
    expect(() => verifyIdToken(hs({ ...base, nonce: 'x' }), exp)).toThrow(/nonce/)
    expect(() => verifyIdToken(hs({ ...base, exp: now() - 600 }), exp)).toThrow(/истёк/)
  })
  it('id_token RS256 проверяется по JWKS', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' }
    const h = b64({ alg: 'RS256', kid: 'k1' })
    const p = b64(base)
    const tok = `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`
    expect(verifyIdToken(tok, { ...exp, jwks: [jwk] }).sub).toBe('u1')
    expect(() => verifyIdToken(tok, { ...exp, jwks: [] })).toThrow()
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' })
    expect(() => verifyIdToken(tok, { ...exp, jwks: [{ ...other, kid: 'k1' }] })).toThrow(/подпись/)
  })
  it('группы → роль (старшая из совпавших), неизвестные группы — нет роли', () => {
    const map = 'mis-admins=ADMIN,mis-doctors=DOCTOR,mis-registrars=REGISTRAR'
    expect(mapGroupsToRole(['mis-registrars', 'mis-doctors'], map)).toBe('DOCTOR')
    expect(mapGroupsToRole(['mis-admins', 'mis-registrars'], map)).toBe('ADMIN')
    expect(mapGroupsToRole(['everyone'], map)).toBeNull()
    expect(mapGroupsToRole(['/mis-admins'], map)).toBe('ADMIN')
    expect(groupsFrom({ groups: ['/a', 'b'] }, 'groups')).toContain('b')
  })
  it('MFA по amr', () => {
    expect(hasMfa({ ...base, amr: ['pwd', 'otp'] } as never)).toBe(true)
    expect(hasMfa({ ...base, amr: ['pwd'] } as never)).toBe(false)
  })
})
