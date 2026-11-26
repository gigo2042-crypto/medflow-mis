// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextResponse } from 'next/server'
import { appMode, clinicTz } from '@/lib/config'
import { oidcEnabled } from '@/lib/oidc'
import { clinic } from '@/lib/clinic'
import { fiscalStatus } from '@/lib/fiscal'
import { maxConfig } from '@/lib/max'

export const dynamic = 'force-dynamic'

// Публичная конфигурация для экрана входа (без секретов)
export async function GET() {
  return NextResponse.json({
    mode: appMode(),
    clinicTz: clinicTz(),
    // реквизиты клиники публичны (печатаются в документах); секретов здесь нет
    clinic: clinic(),
    fiscal: fiscalStatus(),
    max: (() => {
      const m = maxConfig()
      const demo = appMode() === 'demo'
      return { configured: m.configured || demo, demo: demo && !m.configured, problem: m.configured || demo ? null : m.problem }
    })(),
    oidc: oidcEnabled() ? { label: process.env.OIDC_BUTTON_LABEL || 'Войти через корпоративный SSO' } : null,
  })
}
