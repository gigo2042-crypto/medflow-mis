#!/usr/bin/env node
// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Планировщик фоновых задач МИС (отдельный контейнер/процесс). Дёргает служебные
// эндпоинты приложения с заголовком X-Service-Key; сам данных не хранит.
//   каждые 30 с  — напоминания (каскады) и истёкшие приглашения листа ожидания
//   каждые 60 с  — очередь Центра уведомлений; регулярные отчёты
//   каждые 15 мин — обмен с 1С и очереди интеграций
//   демо: ежедневно в DEMO_RESET_AT (по умолчанию 04:00 по CLINIC_TZ) — сброс демо-данных
const APP = (process.env.APP_INTERNAL_URL || 'http://localhost:3000').replace(/\/+$/, '')
const KEY = process.env.SERVICE_KEY || ''
const MODE = process.env.APP_MODE === 'demo' ? 'demo' : 'production'
const TZ = process.env.CLINIC_TZ || 'Europe/Moscow'
const RESET_AT = process.env.DEMO_RESET_AT || '04:00'

if (KEY.length < 24 || KEY === 'medflow-service-key') {
  console.error('[scheduler] SERVICE_KEY не задан или слабый — запуск отменён')
  process.exit(1)
}

const log = (...a) => console.log(new Date().toISOString(), '[scheduler]', ...a)

async function call(path, body = {}) {
  try {
    const res = await fetch(`${APP}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(path.includes('demo/reset') ? 300_000 : 60_000),
    })
    if (!res.ok) log(path, 'HTTP', res.status)
    return res.ok
  } catch (e) {
    log(path, 'недоступно:', e.message)
    return false
  }
}

const running = new Set()
function every(name, ms, fn) {
  const run = async () => {
    if (running.has(name)) return
    running.add(name)
    try {
      await fn()
    } finally {
      running.delete(name)
    }
  }
  setTimeout(run, 5000)
  setInterval(run, ms)
}

every('reminders', 30_000, () => call('/api/reminders', { action: 'PROCESS' }))
every('notifications', 60_000, () => call('/api/notifications', { action: 'PROCESS' }))
every('fiscal', 60_000, () => call('/api/payments/fiscal', { action: 'PROCESS' }))
every('reports', 60_000, () => call('/api/reports/scheduler/tick'))
every('onec', 15 * 60_000, () => call('/api/integrations/1c', { action: 'PROCESS' }))
every('integrations', 15 * 60_000, () => call('/api/integrations', { action: 'PROCESS' }))

if (MODE === 'demo') {
  let lastReset = ''
  every('demo-reset', 60_000, async () => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())
    const get = (t) => parts.find((p) => p.type === t)?.value
    const day = `${get('year')}-${get('month')}-${get('day')}`
    const hm = `${get('hour')}:${get('minute')}`
    if (hm >= RESET_AT && lastReset !== day) {
      if (lastReset === '' && hm > RESET_AT) {
        lastReset = day // запуск позже часа сброса — сброс со следующих суток
        return
      }
      log('ежедневный сброс демо-данных')
      if (await call('/api/demo/reset')) lastReset = day
    }
  })
}

log(`запущен: ${APP}, режим ${MODE}`)
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => process.exit(0))
