// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { API_CSP, baseHeaders, bookFrameAncestors, cspFor, newNonce } from '@/lib/security-headers'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Запрос пришёл со страницы того же сайта? Origin сравнивается с Host (Caddy передаёт исходный Host) и APP_URL. */
export function sameOrigin(origin: string, host: string | null, appUrl: string | undefined): boolean {
  let o: URL
  try {
    o = new URL(origin)
  } catch {
    return false // в т.ч. "null" из sandbox-фреймов и file://
  }
  if (host && o.host.toLowerCase() === host.toLowerCase()) return true
  if (appUrl) {
    try {
      if (new URL(appUrl).origin === o.origin) return true
    } catch {
      /* ignore */
    }
  }
  return false
}

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname
  const mode = process.env.APP_MODE === 'demo' ? 'demo' : 'production'

  // Второй рубеж: в production демо-маршруты отвечают 404, даже если код
  // случайно попал в сборку (в Docker-образе каталог src/app/api/demo удаляется).
  // Вебхук статусов почты нужен только демо-мини-сервису email-provider (в production почта — SMTP,
  // мини-сервиса нет): в production-образе маршрут вырезан, здесь — второй рубеж.
  if (mode !== 'demo' && (path.startsWith('/api/demo') || path.startsWith('/api/integrations/email'))) {
    return new NextResponse('Not Found', { status: 404 })
  }

  // CSRF: изменяющие запросы к API из браузера принимаются только со своего origin.
  // Серверные вызовы (вебхуки MAX/почты, планировщик, curl) Origin не присылают — их защищают подписи и ключи.
  if (path.startsWith('/api/') && MUTATING.has(req.method)) {
    const origin = req.headers.get('origin')
    if (origin !== null && !sameOrigin(origin, req.headers.get('host'), process.env.APP_URL)) {
      return NextResponse.json({ error: 'Запрос с чужого сайта отклонён' }, { status: 403 })
    }
  }

  if (path.startsWith('/api/')) {
    const res = NextResponse.next()
    res.headers.set('Content-Security-Policy', API_CSP)
    return res
  }

  // Страницы: CSP с nonce этого запроса. Next.js берёт nonce из заголовка CSP запроса и
  // проставляет его своим скриптам. /book можно встраивать во фрейм сайтам клиники (WIDGET_ALLOWED_ORIGINS).
  const nonce = newNonce()
  const book = path === '/book' || path.startsWith('/book/')
  const csp = cspFor(book ? bookFrameAncestors(process.env.WIDGET_ALLOWED_ORIGINS) : "'none'", nonce, process.env.NODE_ENV === 'development')
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)
  const res = NextResponse.next({ request: { headers: requestHeaders } })
  if (book) for (const h of baseHeaders) res.headers.set(h.key, h.value)
  res.headers.set('Content-Security-Policy', csp)
  return res
}

export const config = {
  matcher: [
    '/api/:path*',
    // страницы: всё, кроме статики сборки и файлов из public; prefetch-запросы ссылок — без nonce
    {
      source: '/((?!api|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|js|css|txt|map|woff2?)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
