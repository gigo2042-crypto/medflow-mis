// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { describe, expect, it } from 'vitest'
import { validateEnv } from '../../scripts/env-rules.mjs'
import { clockStr, ddmmyyyy, timeStr, zonedTime } from '@/lib/mis-utils'
import { buildProtocolPrint, templateLabel } from '@/lib/protocol-print'

const PROD_OK = {
  APP_MODE: 'production',
  DATABASE_URL: 'postgresql://u:p@db:5432/medflow',
  SESSION_SECRET: 'x'.repeat(40),
  LINK_SECRET: 'l'.repeat(40),
  SERVICE_KEY: 'y'.repeat(30),
  APP_URL: 'https://mis.test',
  WIDGET_ENABLED: '0',
}

describe('Конфигурация (env)', () => {
  it('production без секретов не стартует', () => {
    const e = validateEnv({ APP_MODE: 'production' })
    expect(e.join('\n')).toMatch(/DATABASE_URL/)
    expect(e.join('\n')).toMatch(/SESSION_SECRET/)
    expect(e.join('\n')).toMatch(/SERVICE_KEY/)
  })
  it('валидная production-конфигурация', () => {
    expect(validateEnv(PROD_OK)).toEqual([])
  })
  it('демо-ключ сервиса, плейсхолдеры и http в production — ошибки', () => {
    expect(validateEnv({ ...PROD_OK, SERVICE_KEY: 'medflow-service-key' }).length).toBeGreaterThan(0)
    expect(validateEnv({ ...PROD_OK, SESSION_SECRET: 'CHANGE_ME_' + 'x'.repeat(40) }).join()).toMatch(/CHANGE_ME/)
    expect(validateEnv({ ...PROD_OK, APP_URL: 'http://mis.test' }).join()).toMatch(/https/)
  })
  it('виджет в production — только с капчей', () => {
    const { WIDGET_ENABLED: _w, ...noWidgetFlag } = PROD_OK
    expect(validateEnv(noWidgetFlag).join()).toMatch(/SMARTCAPTCHA/)
    expect(validateEnv({ ...noWidgetFlag, SMARTCAPTCHA_CLIENT_KEY: 'c', SMARTCAPTCHA_SERVER_KEY: 's' })).toEqual([])
  })
  it('OIDC — всё или ничего, карта ролей проверяется', () => {
    expect(validateEnv({ ...PROD_OK, OIDC_ISSUER: 'https://idp' }).join()).toMatch(/OIDC/)
    const full = { ...PROD_OK, OIDC_ISSUER: 'https://idp', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', OIDC_ROLE_MAP: 'g=ADMIN' }
    expect(validateEnv(full)).toEqual([])
    expect(validateEnv({ ...full, OIDC_ROLE_MAP: 'g=GOD' }).join()).toMatch(/OIDC_ROLE_MAP/)
  })
  it('демо-режим в production-сборке запрещён; демо требует DEMO_PASSWORD', () => {
    expect(validateEnv({ ...PROD_OK, APP_MODE: 'demo', MEDFLOW_BUILD: 'production', DEMO_PASSWORD: 'demo-pass-1' }).join()).toMatch(/production-сборке/)
    expect(validateEnv({ ...PROD_OK, APP_MODE: 'demo' }).join()).toMatch(/DEMO_PASSWORD/)
  })
})

describe('Часовой пояс клиники', () => {
  it('время приёма показывается в CLINIC_TZ независимо от TZ сервера', () => {
    const d = zonedTime(2026, 3, 10, 9, 0, 'Europe/Moscow')
    expect(d.toISOString()).toBe('2026-03-10T06:00:00.000Z')
    expect(timeStr(d, 'Europe/Moscow')).toBe('09:00')
    expect(timeStr(d, 'Asia/Novosibirsk')).toBe('13:00')
    expect(clockStr(d, 'Europe/Moscow')).toMatch(/^09:00/)
    // поздний вечер по Москве — уже следующий день по UTC
    const late = zonedTime(2026, 3, 10, 23, 30, 'Asia/Vladivostok')
    expect(ddmmyyyy(late, 'Asia/Vladivostok')).toBe('10.03.2026')
  })
})

describe('Печать протокола', () => {
  const tpl = { sections: [{ title: 'Осмотр', items: [{ key: 'k1', label: 'Отёк десны' }] }] } as never
  it('ключ шаблона → человекочитаемая подпись', () => {
    expect(templateLabel('Осмотр||k1', tpl)).toBe('Осмотр — Отёк десны')
  })
  it('дата — из времени приёма, а не создания визита', () => {
    const text = buildProtocolPrint(
      {
        patient: { lastName: 'Тест', firstName: 'Т', middleName: null, cardNumber: 'MF-1' },
        doctor: { name: 'Врач', specialty: 'Терапевт' },
        appointment: { start: zonedTime(2026, 2, 3, 10, 0).toISOString() },
        templateData: JSON.stringify({ chips: { 'Осмотр||k1': ['да'] } }),
        complaints: null, diagnosisCode: null, diagnosisName: null, protocolText: null,
      },
      tpl,
      { clinicLine: 'Клиника', ageLine: '30' }
    )
    expect(text).toContain('Дата приёма: 03.02.2026')
    expect(text).toContain('Осмотр — Отёк десны: да')
    expect(text).not.toContain('||')
  })
})

describe('LLM: внешний провайдер только с явным флагом (чек-лист P0 ИИ)', () => {
  it('isLocalLlmUrl / llmIsExternal', async () => {
    const { isLocalLlmUrl, llmIsExternal } = await import('../../scripts/env-rules.mjs')
    for (const u of ['http://localhost:11434/v1', 'http://127.0.0.1:8000', 'http://10.0.0.5/v1', 'http://192.168.1.2', 'http://172.20.0.3', 'http://llm.internal:8000', 'http://ollama:11434', 'http://gpu.local']) expect(isLocalLlmUrl(u)).toBe(true)
    for (const u of ['https://api.openai.com/v1', 'https://llm.example.com', 'http://172.32.0.1', 'not a url', '']) expect(isLocalLlmUrl(u)).toBe(false)
    expect(llmIsExternal({ LLM_PROVIDER: 'gigachat' })).toBe(true)
    expect(llmIsExternal({ LLM_PROVIDER: 'none' })).toBe(false)
  })
})
