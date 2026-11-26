// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useEffect, useRef } from 'react'

declare global {
  interface Window {
    smartCaptcha?: { render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; hl?: string }) => number }
  }
}

// Yandex SmartCaptcha: скрипт грузится, только если в настройках задан ключ
export function SmartCaptcha({ siteKey, onToken }: { siteKey: string; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    const render = () => {
      if (!cancelled && ref.current && window.smartCaptcha && !ref.current.dataset.rendered) {
        ref.current.dataset.rendered = '1'
        window.smartCaptcha.render(ref.current, { sitekey: siteKey, callback: onToken, hl: 'ru' })
      }
    }
    if (window.smartCaptcha) {
      render()
    } else {
      const s = document.createElement('script')
      s.src = 'https://smartcaptcha.yandexcloud.net/captcha.js'
      s.defer = true
      s.onload = render
      document.head.appendChild(s)
    }
    return () => {
      cancelled = true
    }
  }, [siteKey, onToken])
  return <div ref={ref} style={{ minHeight: 102 }} />
}
