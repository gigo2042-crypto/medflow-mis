// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Правила переменных окружения — общий модуль для приложения (src/lib/config.ts)
// и для проверки при старте контейнера (scripts/check-env.mjs). Чистый JS без зависимостей.

/** @param {Record<string, string | undefined>} env */
export function appModeOf(env) {
  // По умолчанию — production: демо включается только явно
  return env.APP_MODE === 'demo' ? 'demo' : 'production'
}

/** Реквизиты клиники для печатных форм и чеков: только из env, без выдуманных значений. */
export const CLINIC_REQUIRED = ['CLINIC_NAME', 'CLINIC_INN', 'CLINIC_ADDRESS', 'CLINIC_LICENSE']

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ configured: boolean, missing: string[], demo: boolean, name: string, shortName: string, inn: string, ogrn: string, address: string, phone: string, license: string }}
 */
export function clinicRequisitesFrom(env) {
  if (appModeOf(env) === 'demo' && !env.CLINIC_NAME) {
    // Демо: явно помеченные демонстрационные значения, не похожие на настоящие
    return {
      configured: true, missing: [], demo: true,
      name: 'ДЕМО-КЛИНИКА (реквизиты не настоящие)', shortName: 'Демо-клиника',
      inn: '0000000000', ogrn: '', address: 'ДЕМО: адрес не задан', phone: 'ДЕМО: телефон не задан', license: 'ДЕМО: лицензия не задана',
    }
  }
  const missing = CLINIC_REQUIRED.filter((k) => !env[k] || !String(env[k]).trim())
  return {
    configured: missing.length === 0, missing, demo: false,
    name: env.CLINIC_NAME || '', shortName: env.CLINIC_SHORT_NAME || env.CLINIC_NAME || '',
    inn: env.CLINIC_INN || '', ogrn: env.CLINIC_OGRN || '', address: env.CLINIC_ADDRESS || '',
    phone: env.CLINIC_PHONE || '', license: env.CLINIC_LICENSE || '',
  }
}

/**
 * Предупреждения (не блокируют старт): функции, которые будут недоступны.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function envWarnings(env) {
  const w = []
  if (appModeOf(env) !== 'production') return w
  const c = clinicRequisitesFrom(env)
  if (!c.configured) w.push(`Реквизиты клиники не заданы (${c.missing.join(', ')}): печать документов и чеков недоступна`)
  if (!env.FISCAL_PROVIDER || env.FISCAL_PROVIDER === 'none') w.push('FISCAL_PROVIDER не задан: фискализация 54-ФЗ недоступна, касса покажет предупреждение')
  if (!env.SMS_PROVIDER || env.SMS_PROVIDER === 'none') w.push('SMS_PROVIDER не задан: SMS (напоминания, коды виджета) не отправляются')
  if (!env.MAX_BOT_TOKEN) w.push('MAX_BOT_TOKEN не задан: мессенджер MAX отключён, все сообщения пациентам — по SMS')
  if (env.WIDGET_ENABLED !== '0') {
    const raw = String(env.WIDGET_ALLOWED_ORIGINS || '').split(/[\s,]+/).filter(Boolean)
    if (!raw.length) w.push('WIDGET_ALLOWED_ORIGINS не задан: страница /book открывается напрямую, но встроить её во фрейм на сайт клиники браузер не даст')
    const bad = raw.filter((o) => !/^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/?$/i.test(o) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/?$/i.test(o))
    if (bad.length) w.push(`WIDGET_ALLOWED_ORIGINS: проигнорированы некорректные значения (${bad.join(', ')}) — нужен формат https://домен`)
  }
  if (!env.STAFF_ALERT_EMAIL) w.push('STAFF_ALERT_EMAIL не задан: служебные оповещения (склад, недоставленные письма) — только в журнале Центра уведомлений')
  return w
}

/** Роли с доступом к ПДн — для них 2FA обязательна (дублирует src/lib/auth/twofa-policy.ts). */
export const PD_ROLES = ['ADMIN', 'REGISTRAR', 'DOCTOR', 'HEAD']

const TZ_RE = /^[A-Za-z_]+\/[A-Za-z_\-+0-9/]+$|^UTC$/

/**
 * Возвращает список ошибок конфигурации. Пустой список — конфигурация валидна.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function validateEnv(env) {
  const errors = []
  const mode = appModeOf(env)
  const req = (name, check, hint) => {
    const v = env[name]
    if (!v || !v.trim()) errors.push(`${name}: обязательная переменная не задана${hint ? ` (${hint})` : ''}`)
    else if (check && !check(v)) errors.push(`${name}: некорректное значение${hint ? ` (${hint})` : ''}`)
  }
  if (env.APP_MODE && !['production', 'demo'].includes(env.APP_MODE)) {
    errors.push('APP_MODE: допустимо production или demo')
  }
  // Production-образ собран без демо-кода: включить в нём демо-режим нельзя
  if (env.MEDFLOW_BUILD === 'production' && mode === 'demo') {
    errors.push('APP_MODE=demo недопустим в production-сборке (соберите образ с --build-arg APP_MODE=demo)')
  }
  req('DATABASE_URL', (v) => /^postgres(ql)?:\/\//.test(v), 'postgresql://user:pass@host:5432/db')
  req('SESSION_SECRET', (v) => v.length >= 32, 'не короче 32 символов')
  // Подписанные ссылки пациента — отдельный ключ (ротация сессий не ломает ссылки в SMS и наоборот)
  if (mode === 'production') {
    req('LINK_SECRET', (v) => v.length >= 32 && v !== env.SESSION_SECRET, 'не короче 32 символов и не равен SESSION_SECRET')
    if (env.LINK_SECRET_PREVIOUS && env.LINK_SECRET_PREVIOUS.length < 32) errors.push('LINK_SECRET_PREVIOUS: не короче 32 символов')
  }
  req('SERVICE_KEY', (v) => v.length >= 24 && v !== 'medflow-service-key', 'не короче 24 символов, не демо-значение')
  req('APP_URL', (v) => /^https?:\/\//.test(v), 'публичный адрес, например https://mis.example.ru')
  if (env.CLINIC_TZ && !TZ_RE.test(env.CLINIC_TZ)) errors.push('CLINIC_TZ: ожидается IANA-зона, например Europe/Moscow')

  const ROLES = ['ADMIN', 'HEAD', 'DOCTOR', 'REGISTRAR', 'MARKETER']
  const roleList = (name) => {
    if (!env[name]) return
    const bad = env[name].split(',').map((s) => s.trim().toUpperCase()).filter((r) => r && !ROLES.includes(r))
    if (bad.length) errors.push(`${name}: неизвестные роли ${bad.join(', ')} (допустимо ${ROLES.join(', ')})`)
  }
  roleList('TWO_FA_ROLES')
  roleList('OIDC_MFA_ROLES')
  // 2FA обязательна всем ролям с доступом к ПДн (чек-лист Тони, P0). По умолчанию (переменные пусты) —
  // ADMIN, REGISTRAR, DOCTOR, HEAD; сузить список в production нельзя.
  if (mode === 'production') {
    for (const name of ['TWO_FA_ROLES', 'OIDC_MFA_ROLES']) {
      if (!env[name] || !env[name].trim()) continue
      const list = env[name].split(',').map((s) => s.trim().toUpperCase())
      const missing = PD_ROLES.filter((r) => !list.includes(r))
      if (missing.length) errors.push(`${name}: в production должны входить все роли с доступом к ПДн (нет ${missing.join(', ')})`)
    }
  }
  if (env.OIDC_ROLE_MAP) {
    const pairs = env.OIDC_ROLE_MAP.split(',').map((s) => s.trim()).filter(Boolean)
    const bad = pairs.filter((p) => {
      const [g, r] = p.split('=').map((x) => (x || '').trim())
      return !g || !r || !ROLES.includes(r.toUpperCase())
    })
    if (!pairs.length || bad.length) errors.push('OIDC_ROLE_MAP: формат "группа=РОЛЬ,группа2=РОЛЬ"')
  }
  if (env.REPORT_EMAIL_DOMAINS) {
    const bad = env.REPORT_EMAIL_DOMAINS.split(',').map((s) => s.trim().replace(/^@/, '')).filter((d) => d && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d))
    if (bad.length) errors.push(`REPORT_EMAIL_DOMAINS: некорректные домены ${bad.join(', ')}`)
  }
  if (!!env.SMARTCAPTCHA_CLIENT_KEY !== !!env.SMARTCAPTCHA_SERVER_KEY) {
    errors.push('SMARTCAPTCHA_CLIENT_KEY и SMARTCAPTCHA_SERVER_KEY задаются только вместе')
  }

  if (mode === 'demo') {
    req('DEMO_PASSWORD', (v) => v.length >= 8, 'пароль демо-учёток, не короче 8 символов')
  }

  if (mode === 'production') {
    // Плейсхолдеры из .env.example не принимаются
    const placeholders = Object.keys(env).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k) && String(env[k]).includes('CHANGE_ME'))
    if (placeholders.length) errors.push(`Не заменены плейсхолдеры CHANGE_ME: ${placeholders.sort().join(', ')}`)
    // Публичный виджет записи: в production только с капчей, либо выключен явно
    if (env.WIDGET_ENABLED !== '0' && !env.SMARTCAPTCHA_SERVER_KEY) {
      errors.push('SMARTCAPTCHA_CLIENT_KEY/SMARTCAPTCHA_SERVER_KEY: нужны для публичного виджета (или WIDGET_ENABLED=0)')
    }
    if (env.APP_URL && !env.APP_URL.startsWith('https://') && env.ALLOW_INSECURE_HTTP !== '1') {
      errors.push('APP_URL: в production нужен https:// (для локальной проверки без TLS — ALLOW_INSECURE_HTTP=1)')
    }
    // OIDC: либо полностью не настроен, либо настроен целиком
    const oidc = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_ROLE_MAP']
    const set = oidc.filter((k) => env[k])
    if (set.length > 0 && set.length < oidc.length) {
      errors.push(`OIDC: заданы не все переменные (${oidc.filter((k) => !env[k]).join(', ')})`)
    }
    if (env.SMS_PROVIDER && !['smsru', 'none'].includes(env.SMS_PROVIDER)) errors.push('SMS_PROVIDER: smsru | none')
    if (env.CLINIC_INN && !/^(\d{10}|\d{12})$/.test(env.CLINIC_INN)) errors.push('CLINIC_INN: 10 или 12 цифр')
    // MAX: либо не настроен, либо настроен целиком (токен, имя бота для ссылок, секрет вебхука)
    const maxVars = ['MAX_BOT_TOKEN', 'MAX_BOT_NAME', 'MAX_WEBHOOK_SECRET']
    const maxSet = maxVars.filter((k) => env[k])
    if (maxSet.length > 0 && maxSet.length < maxVars.length) errors.push(`MAX: заданы не все переменные (${maxVars.filter((k) => !env[k]).join(', ')})`)
    if (env.MAX_WEBHOOK_SECRET && !/^[a-zA-Z0-9_-]{5,256}$/.test(env.MAX_WEBHOOK_SECRET)) errors.push('MAX_WEBHOOK_SECRET: 5–256 символов [a-zA-Z0-9_-] (требование MAX)')
    if (env.MAX_BOT_TOKEN && !String(env.APP_URL || '').startsWith('https://')) errors.push('MAX: вебхук принимается только по HTTPS (порт 443) — нужен APP_URL https://')
    if (env.SMS_PROVIDER === 'smsru' && !env.SMSRU_API_ID) errors.push('SMSRU_API_ID: нужен при SMS_PROVIDER=smsru')
    if (env.EMAIL_PROVIDER && !['smtp', 'none'].includes(env.EMAIL_PROVIDER)) errors.push('EMAIL_PROVIDER: smtp | none')
    if (env.EMAIL_PROVIDER === 'smtp') {
      for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM']) if (!env[k]) errors.push(`${k}: нужен при EMAIL_PROVIDER=smtp`)
    }
    const llm = env.LLM_PROVIDER || 'none'
    if (!['none', 'openai', 'yandexgpt', 'gigachat'].includes(llm)) errors.push('LLM_PROVIDER: none | openai | yandexgpt | gigachat')
    if (llm === 'openai') for (const k of ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']) if (!env[k]) errors.push(`${k}: нужен при LLM_PROVIDER=openai`)
    if (llm === 'yandexgpt') for (const k of ['YANDEX_API_KEY', 'YANDEX_FOLDER_ID']) if (!env[k]) errors.push(`${k}: нужен при LLM_PROVIDER=yandexgpt`)
    if (llm === 'gigachat') if (!env.GIGACHAT_AUTH_KEY) errors.push('GIGACHAT_AUTH_KEY: нужен при LLM_PROVIDER=gigachat')
    // Внешний провайдер (облако) — только явным решением клиники: псевдонимизация эвристическая (152-ФЗ)
    if (llmIsExternal(env) && !isTrue(env.LLM_EXTERNAL_ALLOWED)) {
      errors.push(`LLM_PROVIDER=${llm}: данные уходят внешнему провайдеру — нужен явный LLM_EXTERNAL_ALLOWED=1 (после согласования с ответственным за ПДн и договора с провайдером) или локальная модель (LLM_PROVIDER=openai + LLM_BASE_URL внутри контура)`)
    }
    // Мониторинг: метрики только с токеном; отчёты об ошибках — только явно (данные уходят на сервер Sentry)
    if (env.METRICS_TOKEN && env.METRICS_TOKEN.length < 24) errors.push('METRICS_TOKEN: не короче 24 символов (или не задавайте — /api/metrics выключен)')
    if (env.SENTRY_DSN) {
      let host = ''
      try {
        const u = new URL(env.SENTRY_DSN)
        if (u.username && /\/\d+$/.test(u.pathname) && ['https:', 'http:'].includes(u.protocol)) host = u.hostname
      } catch { /* неверный DSN */ }
      if (!host) errors.push('SENTRY_DSN: ожидается https://<ключ>@<хост>/<projectId>')
      else if (!isLocalLlmUrl(`http://${host}`) && !isTrue(env.SENTRY_EXTERNAL_ALLOWED)) errors.push('SENTRY_DSN: внешний сервис — нужен явный SENTRY_EXTERNAL_ALLOWED=1 (тексты ошибок чистятся от ПДн эвристически) или self-hosted Sentry/GlitchTip внутри контура')
    }
    if (env.LOG_FORMAT && !['json', 'text'].includes(env.LOG_FORMAT)) errors.push('LOG_FORMAT: json | text')
  }
  return errors
}

function isTrue(v) {
  return ['1', 'true', 'yes'].includes(String(v || '').trim().toLowerCase())
}

/** Адрес внутри контура клиники: localhost, частные сети, *.internal/*.local/*.lan, имя без точки (сервис в docker-сети). */
export function isLocalLlmUrl(url) {
  let host
  try {
    host = new URL(String(url)).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  if (!host) return false
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return true
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  if (/\.(internal|local|lan|intranet)$/.test(host)) return true
  return !host.includes('.') && !host.includes(':')
}

/** true — запросы ИИ уйдут за пределы контура клиники (YandexGPT, GigaChat, внешний OpenAI-совместимый API). */
export function llmIsExternal(env = process.env) {
  const llm = String(env.LLM_PROVIDER || 'none').toLowerCase()
  if (llm === 'yandexgpt' || llm === 'gigachat') return true
  if (llm === 'openai') return !isLocalLlmUrl(env.LLM_BASE_URL)
  return false
}

/** Внешний ИИ разрешён явным флагом LLM_EXTERNAL_ALLOWED. */
export function llmExternalAllowed(env = process.env) {
  return isTrue(env.LLM_EXTERNAL_ALLOWED)
}
