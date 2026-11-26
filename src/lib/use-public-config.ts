// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'
// Публичная конфигурация (реквизиты клиники, статус ККТ) для компонентов: один запрос на вкладку
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { PublicConfig } from '@/lib/public-config'

let cached: Promise<PublicConfig> | null = null

export function usePublicConfig(): PublicConfig | null {
  const [cfg, setCfg] = useState<PublicConfig | null>(null)
  useEffect(() => {
    let alive = true
    if (!cached) cached = api<PublicConfig>('/api/config')
    cached.then((c) => alive && setCfg(c)).catch(() => {
      cached = null
    })
    return () => {
      alive = false
    }
  }, [])
  return cfg
}
