// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Демо-провайдер OIDC «ClinicCorp ID» — ТОЛЬКО для демо-стенда.
// Реализует ровно то, что нужно для проверки настоящего OIDC-клиента МИС:
//   discovery, authorization code + PKCE (S256, обязательно), точный белый список
//   redirect_uri, секрет клиента из env, id_token HS256 (подпись секретом клиента),
//   claim groups (роль в МИС), второй фактор для администраторов (amr: otp).
// В production используется внешний IdP (Keycloak, Яндекс ID, Azure AD …).
import { createServer } from 'node:http'
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

const env = process.env
const PORT = Number(env.IDP_PORT || 3041)
const ISSUER = (env.IDP_ISSUER || '').replace(/\/+$/, '')
const INTERNAL = (env.IDP_INTERNAL_URL || ISSUER).replace(/\/+$/, '')
const CLIENT_ID = env.IDP_CLIENT_ID || ''
const CLIENT_SECRET = env.IDP_CLIENT_SECRET || ''
const REDIRECTS = (env.IDP_REDIRECT_URIS || '').split(',').map((s) => s.trim()).filter(Boolean)
const USER_PASSWORD = env.DEMO_SSO_PASSWORD || ''

const problems = []
if (!ISSUER) problems.push('IDP_ISSUER')
if (!CLIENT_ID) problems.push('IDP_CLIENT_ID')
if (CLIENT_SECRET.length < 16) problems.push('IDP_CLIENT_SECRET (>=16 символов)')
if (REDIRECTS.length === 0) problems.push('IDP_REDIRECT_URIS')
if (!USER_PASSWORD) problems.push('DEMO_SSO_PASSWORD')
if (problems.length) {
  console.error(`[demo-idp] не заданы: ${problems.join(', ')} — запуск отменён`)
  process.exit(1)
}

// Демо-сотрудники корпоративного клиента; группы → роли МИС (OIDC_ROLE_MAP в МИС)
const USERS = {
  'anna@clinic-corp.example': { sub: 'anna@clinic-corp.example', name: 'Иванова Анна', groups: ['mis-registrars'], mfa: false },
  'dmitry@holding.example': { sub: 'dmitry@holding.example', name: 'Волков Дмитрий', groups: ['mis-heads'], mfa: false },
  'olga@clinic-corp.example': { sub: 'olga@clinic-corp.example', name: 'Шестакова Ольга', groups: ['mis-admins'], mfa: true },
}

const pendingOtp = new Map() // txn -> { auth, user, code, exp, attempts }
const codes = new Map() // code -> { auth, user, amr, exp }
const tokens = new Map() // access_token -> { user, exp }

const b64url = (b) => Buffer.from(b).toString('base64url')
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

function sweep() {
  const now = Date.now()
  for (const m of [pendingOtp, codes, tokens]) for (const [k, v] of m) if (v.exp < now) m.delete(k)
}
setInterval(sweep, 30_000).unref()

function signIdToken(claims) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(claims))
  const sig = createHmac('sha256', CLIENT_SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string'
  res.writeHead(status, {
    'Content-Type': isStr ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  })
  res.end(isStr ? body : JSON.stringify(body))
}

function page(title, inner) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f1f5f9;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.c{background:#fff;border-radius:12px;padding:24px;width:340px;box-shadow:0 4px 20px #0001}h1{font-size:18px;margin:0 0 4px}p{color:#64748b;font-size:13px}
input{width:100%;box-sizing:border-box;padding:9px;margin:6px 0;border:1px solid #cbd5e1;border-radius:8px}button{width:100%;padding:10px;background:#4f46e5;color:#fff;border:0;border-radius:8px;margin-top:8px;cursor:pointer}
.e{color:#be123c;font-size:13px}.d{background:#fef3c7;color:#92400e;padding:6px 8px;border-radius:6px;font-size:12px}</style></head>
<body><div class="c"><h1>ClinicCorp ID</h1><p>Демо-провайдер единого входа (только для демо-стенда)</p>${inner}</div></body></html>`
}

function hidden(auth) {
  return ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge', 'code_challenge_method', 'scope']
    .map((k) => `<input type="hidden" name="${k}" value="${esc(auth[k])}">`)
    .join('')
}

function validateAuth(q) {
  if (q.client_id !== CLIENT_ID) return 'Неизвестный client_id'
  if (!REDIRECTS.includes(q.redirect_uri)) return 'redirect_uri не в белом списке клиента'
  if (q.response_type && q.response_type !== 'code') return 'Поддерживается только response_type=code'
  if (!q.state || q.state.length < 16) return 'Нет state'
  if (!q.nonce) return 'Нет nonce'
  if (!q.code_challenge || q.code_challenge_method !== 'S256') return 'Требуется PKCE (S256)'
  return null
}

function issueCode(res, auth, user, amr) {
  const code = randomBytes(32).toString('base64url')
  codes.set(code, { auth, user, amr, exp: Date.now() + 60_000 })
  const u = new URL(auth.redirect_uri)
  u.searchParams.set('code', code)
  u.searchParams.set('state', auth.state)
  res.writeHead(302, { Location: u.toString(), 'Cache-Control': 'no-store' })
  res.end()
}

async function readForm(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > 64 * 1024) throw new Error('too large')
    chunks.push(c)
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://idp.local')
    const path = url.pathname.replace(/^\/idp(?=\/)/, '') // допускаем публикацию под /idp
    const q = Object.fromEntries(url.searchParams)

    if (path === '/.well-known/openid-configuration') {
      return send(res, 200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${INTERNAL}/token`,
        userinfo_endpoint: `${INTERNAL}/userinfo`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['HS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        scopes_supported: ['openid', 'profile', 'email'],
        claims_supported: ['sub', 'name', 'email', 'groups', 'amr'],
      })
    }

    if (path === '/authorize' && req.method === 'GET') {
      const err = validateAuth(q)
      // при неверном redirect_uri НЕ редиректим (защита от open redirect)
      if (err) return send(res, 400, page('Ошибка', `<p class="e">${esc(err)}</p>`))
      return send(res, 200, page('Вход', `<form method="post" action="${esc(ISSUER)}/authorize">${hidden(q)}
<input name="email" type="email" placeholder="E-mail" required autofocus><input name="password" type="password" placeholder="Пароль" required>
<button>Войти</button></form>`))
    }

    if (path === '/authorize' && req.method === 'POST') {
      const f = await readForm(req)
      const err = validateAuth(f)
      if (err) return send(res, 400, page('Ошибка', `<p class="e">${esc(err)}</p>`))
      const user = USERS[String(f.email || '').toLowerCase()]
      if (!user || !safeEq(f.password, USER_PASSWORD)) {
        return send(res, 401, page('Вход', `<p class="e">Неверный e-mail или пароль</p><form method="post" action="${esc(ISSUER)}/authorize">${hidden(f)}
<input name="email" type="email" placeholder="E-mail" value="${esc(f.email)}" required><input name="password" type="password" placeholder="Пароль" required autofocus><button>Войти</button></form>`))
      }
      if (user.mfa) {
        const txn = randomBytes(24).toString('base64url')
        const code = String(randomInt(100000, 1000000))
        pendingOtp.set(txn, { auth: f, user, code, exp: Date.now() + 5 * 60_000, attempts: 0 })
        return send(res, 200, page('Второй фактор', `<p>Для администраторов обязателен второй фактор.</p><div class="d">Демо: код — <b>${code}</b></div>
<form method="post" action="${esc(ISSUER)}/otp"><input type="hidden" name="txn" value="${txn}"><input name="code" inputmode="numeric" placeholder="Код из 6 цифр" required autofocus><button>Подтвердить</button></form>`))
      }
      return issueCode(res, f, user, ['pwd'])
    }

    if (path === '/otp' && req.method === 'POST') {
      const f = await readForm(req)
      const p = pendingOtp.get(String(f.txn || ''))
      if (!p || p.exp < Date.now()) return send(res, 400, page('Ошибка', '<p class="e">Код истёк — начните вход заново</p>'))
      if (!safeEq(String(f.code || '').trim(), p.code)) {
        p.attempts++
        if (p.attempts >= 5) pendingOtp.delete(String(f.txn))
        return send(res, 401, page('Ошибка', '<p class="e">Неверный код</p>'))
      }
      pendingOtp.delete(String(f.txn))
      return issueCode(res, p.auth, p.user, ['pwd', 'otp', 'mfa'])
    }

    if (path === '/token' && req.method === 'POST') {
      const f = await readForm(req)
      let cid = f.client_id
      let secret = f.client_secret
      const basic = req.headers.authorization
      if (basic && basic.startsWith('Basic ')) {
        const [u, ...rest] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':')
        cid = decodeURIComponent(u)
        secret = decodeURIComponent(rest.join(':'))
      }
      if (cid !== CLIENT_ID || !safeEq(secret, CLIENT_SECRET)) return send(res, 401, { error: 'invalid_client' })
      if (f.grant_type !== 'authorization_code') return send(res, 400, { error: 'unsupported_grant_type' })
      const c = codes.get(String(f.code || ''))
      codes.delete(String(f.code || '')) // одноразовый
      if (!c || c.exp < Date.now()) return send(res, 400, { error: 'invalid_grant' })
      if (c.auth.redirect_uri !== f.redirect_uri) return send(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
      const challenge = createHash('sha256').update(String(f.code_verifier || '')).digest('base64url')
      if (!safeEq(challenge, c.auth.code_challenge)) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
      const now = Math.floor(Date.now() / 1000)
      const accessToken = randomBytes(32).toString('base64url')
      tokens.set(accessToken, { user: c.user, exp: Date.now() + 3600_000 })
      const idToken = signIdToken({
        iss: ISSUER, sub: c.user.sub, aud: CLIENT_ID, iat: now, exp: now + 300, nonce: c.auth.nonce,
        name: c.user.name, email: c.user.sub, groups: c.user.groups, amr: c.amr,
      })
      return send(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, id_token: idToken })
    }

    if (path === '/userinfo') {
      const h = req.headers.authorization || ''
      const t = tokens.get(h.replace(/^Bearer\s+/i, ''))
      if (!t || t.exp < Date.now()) return send(res, 401, { error: 'invalid_token' })
      return send(res, 200, { sub: t.user.sub, name: t.user.name, email: t.user.sub, groups: t.user.groups })
    }

    if (path === '/health') return send(res, 200, { ok: true })
    return send(res, 404, { error: 'not_found' })
  } catch (e) {
    console.error('[demo-idp]', e)
    return send(res, 500, { error: 'server_error' })
  }
})

server.listen(PORT, () => console.log(`[demo-idp] ClinicCorp ID на :${PORT}, issuer ${ISSUER}`))
