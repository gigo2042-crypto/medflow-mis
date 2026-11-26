#!/usr/bin/env node
// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Проверка окружения перед стартом: без обязательных секретов процесс не запускается.
import { validateEnv, appModeOf, envWarnings } from './env-rules.mjs'

const errors = validateEnv(process.env)
if (errors.length) {
  console.error(`[medflow] Конфигурация (${appModeOf(process.env)}) невалидна — запуск остановлен:`)
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}
for (const w of envWarnings(process.env)) console.warn('[medflow] Внимание: ' + w)
console.log(`[medflow] Конфигурация OK, режим: ${appModeOf(process.env)}`)
