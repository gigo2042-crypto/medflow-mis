// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import type { NextConfig } from 'next'

import { baseHeaders } from './src/lib/security-headers'

// Все страницы, кроме /book: запрет встраивания (X-Frame-Options: DENY). CSP (с nonce на каждый
// запрос, frame-ancestors) ставит src/proxy.ts — для /book frame-ancestors из WIDGET_ALLOWED_ORIGINS.
const securityHeaders = [...baseHeaders, { key: 'X-Frame-Options', value: 'DENY' }]

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path((?!book(?:/|$)).*)', headers: securityHeaders }]
  },
}

export default nextConfig
