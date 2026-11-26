#!/usr/bin/env node
// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Подписка бота MAX на вебхук МИС (однократно после настройки или смены домена).
// По документации MAX (POST /subscriptions): url — только https на порту 443,
// secret ^[a-zA-Z0-9_-]{5,256}$ приходит в заголовке X-Max-Bot-Api-Secret.
// Запуск: node scripts/max-subscribe.mjs            — подписать
//         node scripts/max-subscribe.mjs --list     — показать текущие подписки (GET /subscriptions)
// Переменные: MAX_BOT_TOKEN, MAX_WEBHOOK_SECRET, APP_URL[, MAX_API_URL]. Токен не печатается.
const api = (process.env.MAX_API_URL || 'https://platform-api2.max.ru').replace(/\/+$/, '')
const token = process.env.MAX_BOT_TOKEN
const secret = process.env.MAX_WEBHOOK_SECRET
const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '')
if (!token) {
  console.error('MAX_BOT_TOKEN не задан')
  process.exit(1)
}
const headers = { Authorization: token, 'Content-Type': 'application/json' }
if (process.argv.includes('--list')) {
  const r = await fetch(`${api}/subscriptions`, { headers })
  console.log(r.status, JSON.stringify(await r.json().catch(() => null), null, 2))
  process.exit(r.ok ? 0 : 1)
}
if (!appUrl.startsWith('https://')) {
  console.error('APP_URL должен начинаться с https:// — MAX доставляет вебхуки только по HTTPS (порт 443)')
  process.exit(1)
}
if (!secret || !/^[a-zA-Z0-9_-]{5,256}$/.test(secret)) {
  console.error('MAX_WEBHOOK_SECRET: 5–256 символов [a-zA-Z0-9_-]')
  process.exit(1)
}
const body = {
  url: `${appUrl}/api/integrations/max/webhook`,
  update_types: ['bot_started', 'bot_stopped', 'dialog_removed', 'message_created', 'message_callback'],
  secret,
}
const r = await fetch(`${api}/subscriptions`, { method: 'POST', headers, body: JSON.stringify(body) })
const j = await r.json().catch(() => null)
console.log(`POST /subscriptions → HTTP ${r.status}`, JSON.stringify(j))
process.exit(r.ok && j?.success !== false ? 0 : 1)
