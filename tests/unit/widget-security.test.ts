// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { describe, expect, it } from 'vitest'
import { API_CSP, bookFrameAncestors, cspFor, newNonce, widgetAllowedOrigins } from '@/lib/security-headers'
import { sameOrigin } from '@/proxy'
import { normalizePhone } from '@/lib/mis-utils'

describe('CSP и frame-ancestors (#17, 3.5)', () => {
  it('страницы МИС: встраивание запрещено', () => {
    const csp = cspFor("'none'", 'TESTNONCE')
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
  })
  it('P2: скрипты только по nonce, без unsafe-inline и unsafe-eval (eval — только dev)', () => {
    const script = cspFor("'none'", 'TESTNONCE').split('; ').find((d) => d.startsWith('script-src'))!
    expect(script).toContain("'nonce-TESTNONCE'")
    expect(script).toContain("'strict-dynamic'")
    expect(script).not.toContain('unsafe-inline')
    expect(script).not.toContain('unsafe-eval')
    expect(cspFor("'none'", 'N', true)).toContain("'unsafe-eval'")
    expect(API_CSP).toContain("default-src 'none'")
  })
  it('nonce: 128 бит base64, каждый раз новый', () => {
    const a = newNonce()
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(new Set(Array.from({ length: 100 }, newNonce)).size).toBe(100)
  })
  it('/book: только self и корректные https-origin из WIDGET_ALLOWED_ORIGINS', () => {
    expect(bookFrameAncestors(undefined)).toBe("'self'")
    expect(bookFrameAncestors('https://clinic.example, https://www.clinic.example/')).toBe("'self' https://clinic.example https://www.clinic.example")
    // мусор, http не-localhost, пути, подстановки, внедрение директив — отбрасываются
    expect(widgetAllowedOrigins("http://clinic.example https://a.example/path * 'unsafe-inline' https://x.example;script-src javascript:alert(1)")).toEqual([])
    expect(widgetAllowedOrigins('http://localhost:8080')).toEqual(['http://localhost:8080'])
  })
})

describe('проверка Origin для изменяющих запросов (3.6)', () => {
  it('свой хост и APP_URL — да; чужие, поддомены, null — нет', () => {
    expect(sameOrigin('https://mis.clinic.example', 'mis.clinic.example', undefined)).toBe(true)
    expect(sameOrigin('https://mis.clinic.example', 'app:3000', 'https://mis.clinic.example')).toBe(true)
    expect(sameOrigin('https://evil.example', 'mis.clinic.example', 'https://mis.clinic.example')).toBe(false)
    expect(sameOrigin('https://demo.clinic.example', 'mis.clinic.example', 'https://mis.clinic.example')).toBe(false)
    expect(sameOrigin('null', 'mis.clinic.example', undefined)).toBe(false)
  })
})

describe('нормализация телефона (4.7)', () => {
  it('8…, +7…, 9… (10 цифр) — один и тот же номер', () => {
    const v = ['8 (900) 123-45-67', '+7 900 123 45 67', '79001234567', '9001234567'].map(normalizePhone)
    expect(new Set(v)).toEqual(new Set(['79001234567']))
    expect(normalizePhone('+44 20 7946 0000')).toBe('442079460000') // не российские не трогаем
  })
})
