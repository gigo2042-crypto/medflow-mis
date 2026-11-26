// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { oidcMfaRoles } from '@/lib/auth/twofa-policy'
import { db } from '@/lib/db'
import { audit, createAuthSession, setSessionCookie } from '@/lib/auth-server'
import { appUrl, requiredEnv, secureCookies } from '@/lib/config'
import {
  decodeFlowCookie, discover, groupsFrom, hasMfa, mapGroupsToRole, oidcEnabled, OIDC_COOKIE,
  redirectUri, safeEqual, verifyIdToken, fetchJwks, idTokenAlg,
} from '@/lib/oidc'

export const dynamic = 'force-dynamic'

function fail(code: string): NextResponse {
  const res = NextResponse.redirect(`${appUrl()}/?auth_error=${encodeURIComponent(code)}`, 302)
  res.cookies.set(OIDC_COOKIE, '', { httpOnly: true, secure: secureCookies(), sameSite: 'lax', path: '/api/auth/oidc', maxAge: 0 })
  return res
}

// Возврат из IdP: проверка state по куке (не по sessionStorage), обмен кода с PKCE,
// проверка id_token (iss/aud/exp/nonce), роль — из групп IdP по OIDC_ROLE_MAP.
export async function GET(req: NextRequest) {
  if (!oidcEnabled()) return NextResponse.json({ error: 'Единый вход не настроен' }, { status: 404 })
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  if (req.nextUrl.searchParams.get('error')) return fail('sso_denied')
  const flow = decodeFlowCookie(req.cookies.get(OIDC_COOKIE)?.value)
  if (!code || !state || !flow || !safeEqual(state, flow.state)) {
    await audit('auth.sso_state_mismatch', null, {})
    return fail('sso_state')
  }
  try {
    const d = await discover()
    const clientId = requiredEnv('OIDC_CLIENT_ID')
    const clientSecret = requiredEnv('OIDC_CLIENT_SECRET')
    const tokenRes = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: flow.verifier,
      }).toString(),
      signal: AbortSignal.timeout(8000),
    })
    const tokens = (await tokenRes.json().catch(() => ({}))) as { id_token?: string; access_token?: string }
    if (!tokenRes.ok || !tokens.id_token) return fail('sso_token')
    const jwks = idTokenAlg(tokens.id_token) !== 'HS256' && d.jwks_uri ? await fetchJwks(d.jwks_uri) : []
    const claims = verifyIdToken(tokens.id_token, { issuer: requiredEnv('OIDC_ISSUER'), clientId, nonce: flow.nonce, clientSecret, jwks })

    // Группы: из id_token, иначе из userinfo
    const claimName = process.env.OIDC_GROUPS_CLAIM || 'groups'
    let groups = groupsFrom(claims, claimName)
    let profile: Record<string, unknown> = claims
    if (groups.length === 0 && d.userinfo_endpoint && tokens.access_token) {
      const ui = await fetch(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(6000) })
      if (ui.ok) {
        profile = (await ui.json()) as Record<string, unknown>
        if (profile.sub !== claims.sub) return fail('sso_userinfo')
        groups = groupsFrom(profile, claimName)
      }
    }
    const role = mapGroupsToRole(groups, requiredEnv('OIDC_ROLE_MAP'))
    if (!role) {
      await audit('auth.sso_no_role', null, { sub: claims.sub, groups })
      return fail('sso_no_role')
    }
    // 2FA для привилегированных ролей через SSO: требуем подтверждения MFA от IdP (amr/acr)
    const mfaRoles = oidcMfaRoles()
    if (mfaRoles.includes(role) && !hasMfa(claims)) {
      await audit('auth.sso_mfa_required', null, { sub: claims.sub, role })
      return fail('sso_mfa_required')
    }

    const subject = `${claims.iss}|${claims.sub}`
    const name = String(profile.name || claims.name || claims.preferred_username || claims.email || claims.sub)
    const email = (profile.email || claims.email) as string | undefined
    let user = await db.staffUser.findUnique({ where: { ssoSubject: subject } })
    if (!user) {
      user = await db.staffUser.create({
        data: { login: `sso:${(email || claims.sub).toLowerCase()}`.slice(0, 120), name, role, email: email ?? null, ssoSubject: subject },
      })
      await audit('auth.sso_user_provisioned', user.id, { role })
    } else {
      if (!user.active) return fail('sso_disabled')
      if (user.role !== role || user.name !== name) {
        user = await db.staffUser.update({ where: { id: user.id }, data: { role, name } })
        await audit('auth.sso_role_synced', user.id, { role })
      }
    }
    const token = await createAuthSession(user.id)
    await audit('auth.sso_login', user.id, { role, mfa: hasMfa(claims) })
    const res = NextResponse.redirect(`${appUrl()}/`, 302)
    res.cookies.set(OIDC_COOKIE, '', { httpOnly: true, secure: secureCookies(), sameSite: 'lax', path: '/api/auth/oidc', maxAge: 0 })
    return setSessionCookie(res, token)
  } catch (e) {
    console.error('[oidc/callback]', (e as Error).message)
    return fail('sso_error')
  }
}
