// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Заполнение демо-данными: `npm run demo:seed`. Только для APP_MODE=demo —
// в production первый администратор создаётся командой `npm run cli -- create-admin`.
import { PrismaClient } from '@prisma/client'
import { seedDemo } from '../src/demo/seed'

async function run() {
  if (process.env.APP_MODE !== 'demo') {
    console.error('Отказ: демо-данные загружаются только при APP_MODE=demo')
    process.exit(1)
  }
  const password = process.env.DEMO_PASSWORD
  if (!password) {
    console.error('Задайте DEMO_PASSWORD (пароль демо-учёток)')
    process.exit(1)
  }
  const db = new PrismaClient()
  try {
    await seedDemo(db, { password, ssoIssuer: process.env.OIDC_ISSUER })
  } finally {
    await db.$disconnect()
  }
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
