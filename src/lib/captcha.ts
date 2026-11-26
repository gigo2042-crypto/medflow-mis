// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Yandex SmartCaptcha для публичного виджета записи. Включается ключами
// SMARTCAPTCHA_CLIENT_KEY (в браузер) и SMARTCAPTCHA_SERVER_KEY (проверка на сервере).
export function captchaSiteKey(): string | null {
  return process.env.SMARTCAPTCHA_SERVER_KEY && process.env.SMARTCAPTCHA_CLIENT_KEY ? process.env.SMARTCAPTCHA_CLIENT_KEY : null
}

export async function verifyCaptcha(token: string | undefined, ip: string): Promise<boolean> {
  const secret = process.env.SMARTCAPTCHA_SERVER_KEY
  if (!secret) return true // капча не настроена — защищают только лимиты
  if (!token) return false
  try {
    const url = new URL(process.env.SMARTCAPTCHA_VALIDATE_URL || 'https://smartcaptcha.yandexcloud.net/validate')
    url.searchParams.set('secret', secret)
    url.searchParams.set('token', token)
    url.searchParams.set('ip', ip)
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return false
    const j = (await res.json()) as { status?: string }
    return j.status === 'ok'
  } catch {
    return false
  }
}
