// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextResponse } from 'next/server'
import { demoOnly } from '@/lib/demo-guard'

export const dynamic = 'force-dynamic'

// Подсказки экрана входа демо-стенда. В production маршрута нет.
export async function GET() {
  const blocked = demoOnly()
  if (blocked) return blocked
  return NextResponse.json({
    password: process.env.DEMO_PASSWORD || '',
    accounts: [
      { login: 'admin', label: 'Администратор' },
      { login: 'reg1', label: 'Регистратор' },
      { login: 'doc1', label: 'Врач' },
      { login: 'mkt', label: 'Маркетолог' },
      { login: 'head', label: 'Руководитель' },
    ],
    sso: process.env.OIDC_ISSUER
      ? [
          { email: 'anna@clinic-corp.example', note: 'регистратор' },
          { email: 'dmitry@holding.example', note: 'руководитель' },
          { email: 'olga@clinic-corp.example', note: 'администратор, нужен код' },
        ]
      : [],
    ssoPassword: process.env.DEMO_SSO_PASSWORD || '',
  })
}
