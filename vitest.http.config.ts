// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { defineConfig } from 'vitest/config'

// Чёрный ящик по HTTP: MEDFLOW_BASE_URL — адрес запущенного стенда.
export default defineConfig({
  test: { include: ['tests/http/**/*.test.ts'], environment: 'node', testTimeout: 90_000, hookTimeout: 60_000, fileParallelism: false },
})
