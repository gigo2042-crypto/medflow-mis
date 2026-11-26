// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { defineConfig } from 'vitest/config'
import path from 'path'

// Интеграционные тесты на настоящей PostgreSQL (одноразовая БД с миграциями):
//   TEST_DATABASE_URL=postgresql://…/medflow_test npx prisma migrate deploy && npm run test:db
// Внешние сервисы (SMS.ru, MAX, АТОЛ) не вызываются — fetch подменяется моком.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: { include: ['tests/db/**/*.test.ts'], environment: 'node', testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false },
})
