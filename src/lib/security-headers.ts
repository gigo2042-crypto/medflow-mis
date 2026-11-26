// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Заголовки безопасности: базовые — в next.config.ts, CSP с nonce — в src/proxy.ts на каждый запрос.
// Без зависимостей от Node API — модуль выполняется и в edge-рантайме proxy.

export const baseHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

const CAPTCHA = 'https://smartcaptcha.yandexcloud.net'

/**
 * CSP для страниц. Скрипты — только с nonce этого запроса ('strict-dynamic': бандлы Next.js и
 * загружаемые ими скрипты, например капча); 'unsafe-inline' для скриптов нет. Nonce создаёт
 * src/proxy.ts на каждый запрос, Next.js сам проставляет его своим скриптам (страницы динамические).
 * Стили: 'unsafe-inline' остаётся — атрибуты style у компонентов (Radix, recharts) nonce не поддерживают.
 * dev: React требует 'unsafe-eval' (только NODE_ENV=development).
 */
export function cspFor(frameAncestors: string, nonce: string, dev = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${CAPTCHA}${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${CAPTCHA}`,
    `frame-src 'self' blob: ${CAPTCHA}`,
    `frame-ancestors ${frameAncestors}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
}

/** CSP для ответов API (JSON): ничего не исполняется и не встраивается. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

/** Случайный nonce (128 бит, base64) — работает и в edge-рантайме proxy. */
export function newNonce(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}

/** WIDGET_ALLOWED_ORIGINS="https://clinic.example https://www.clinic.example" → только корректные https-origin (http — для localhost). */
export function widgetAllowedOrigins(raw: string | undefined): string[] {
  const out: string[] = []
  for (const part of String(raw || '').split(/[\s,]+/)) {
    // строго схема://хост[:порт] — иначе через значение можно внедрить директиву CSP (например, «;script-src …»)
    if (!part || !/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?\/?$/i.test(part)) continue
    try {
      const u = new URL(part)
      const okProto = u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))
      if (okProto && u.origin === part.replace(/\/+$/, '')) out.push(u.origin)
    } catch {
      /* мусор игнорируем */
    }
  }
  return Array.from(new Set(out))
}

/** frame-ancestors для /book: сама МИС + разрешённые сайты клиники; без списка — только 'self'. */
export function bookFrameAncestors(raw: string | undefined): string {
  return ["'self'", ...widgetAllowedOrigins(raw)].join(' ')
}
