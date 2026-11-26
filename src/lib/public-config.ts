// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Публичная конфигурация, которую фронтенд получает с /api/config (без секретов)
export interface PublicConfig {
  mode: 'production' | 'demo'
  clinicTz: string
  oidc: { label: string } | null
  clinic: {
    configured: boolean
    missing: string[]
    demo: boolean
    name: string
    shortName: string
    inn: string
    ogrn: string
    address: string
    phone: string
    license: string
  }
  fiscal: { provider: string; configured: boolean; demo: boolean; problem: string | null }
  max: { configured: boolean; demo: boolean; problem: string | null }
}
