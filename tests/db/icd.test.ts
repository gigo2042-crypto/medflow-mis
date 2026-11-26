// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Регрессия: диагноз проверяется по справочнику МКБ-10 в БД (после импорта НСИ), неактуальные коды отклоняются.
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDb, useTestDb } from './helpers'

useTestDb()
let db: Awaited<ReturnType<typeof resetDb>>

beforeEach(async () => {
  db = await resetDb()
})

describe('МКБ-10 в БД', () => {
  it('пустая таблица — встроенный список; после импорта — только справочник БД', async () => {
    const { resolveIcd } = await import('@/lib/icd-db')
    expect(await resolveIcd('K02.1')).toMatchObject({ code: 'K02.1' })
    await db.icdCode.createMany({
      data: [
        { code: 'A00.0', name: 'Холера, вызванная холерным вибрионом 01, биовар cholerae', source: 'NSI_CSV' },
        { code: 'Z99.9', name: 'Тестовый неактуальный', actual: false, source: 'NSI_CSV' },
      ],
    })
    // кэш признака загрузки — 60 с; сбрасываем модуль
    const vi = await import('vitest')
    vi.vi.resetModules()
    const fresh = await import('@/lib/icd-db')
    expect(await fresh.resolveIcd('a00.0')).toMatchObject({ code: 'A00.0' })
    expect(await fresh.resolveIcd('Z99.9')).toBeNull()
    expect(await fresh.resolveIcd('K02.1')).toBeNull() // нет в загруженном справочнике
    expect((await fresh.searchIcdDb('холер')).items.map((i) => i.code)).toEqual(['A00.0'])
  })
})
