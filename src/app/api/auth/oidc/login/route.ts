// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { secureCookies, requiredEnv } from '@/lib/config'
import { discover, encodeFlowCookie, oidcEnabled, OIDC_COOKIE, OIDC_COOKIE_TTL_SEC, pkcePair, redirectUri } from '@/lib/oidc'

export const dynamic = 'force-dynamic'

// Начало входа через OIDC: state/nonce/code_verifier — в подписанной httpOnly-куке
export async function GET() {
  if (!oidcEnabled()) return NextResponse.json({ error: 'Единый вход не настроен' }, { status: 404 })
  try {
    const d = await discover()
    const { verifier, challenge } = pkcePair()
    const state = randomBytes(24).toString('base64url')
    const nonce = randomBytes(24).toString('base64url')
    const url = new URL(d.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', requiredEnv('OIDC_CLIENT_ID'))
    url.searchParams.set('redirect_uri', redirectUri())
    url.searchParams.set('scope', process.env.OIDC_SCOPES || 'openid profile email')
    url.searchParams.set('state', state)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    const res = NextResponse.redirect(url.toString(), 302)
    res.cookies.set(OIDC_COOKIE, encodeFlowCookie({ state, nonce, verifier, exp: Date.now() + OIDC_COOKIE_TTL_SEC * 1000 }), {
      httpOnly: true,
      secure: secureCookies(),
      sameSite: 'lax',
      path: '/api/auth/oidc',
      maxAge: OIDC_COOKIE_TTL_SEC,
    })
    return res
  } catch (e) {
    console.error('[oidc/login]', e)
    return NextResponse.redirect(new URL('/?auth_error=sso_unavailable', process.env.APP_URL).toString(), 302)
  }
}
