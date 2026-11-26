// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Регрессия: отменённые записи и неявки не удаляются и не сдвигаются ради освобождения слота;
// двойная бронь активных записей по-прежнему невозможна (частичный уникальный индекс).
import { beforeEach, describe, expect, it } from 'vitest'
import { makeDoctor, makePatient, resetDb, useTestDb } from './helpers'

useTestDb()
let db: Awaited<ReturnType<typeof resetDb>>

beforeEach(async () => {
  db = await resetDb()
})

describe('Слоты расписания', () => {
  it('отменённая запись остаётся в истории, слот свободен для новой брони', async () => {
    const d = await makeDoctor(db)
    const p1 = await makePatient(db)
    const p2 = await makePatient(db)
    const start = new Date(Date.now() + 86400_000)
    const a1 = await db.appointment.create({ data: { patientId: p1.id, doctorId: d.id, start } })
    await db.appointment.update({ where: { id: a1.id }, data: { status: 'CANCELED' } })
    const a2 = await db.appointment.create({ data: { patientId: p2.id, doctorId: d.id, start } })
    const both = await db.appointment.findMany({ where: { doctorId: d.id, start } })
    expect(both.map((a) => a.id).sort()).toEqual([a1.id, a2.id].sort())
    expect((await db.appointment.findUniqueOrThrow({ where: { id: a1.id } })).start.getTime()).toBe(start.getTime())
  })

  it('двойная бронь активного слота — P2002', async () => {
    const d = await makeDoctor(db)
    const p1 = await makePatient(db)
    const start = new Date(Date.now() + 86400_000)
    await db.appointment.create({ data: { patientId: p1.id, doctorId: d.id, start } })
    await expect(db.appointment.create({ data: { patientId: p1.id, doctorId: d.id, start } })).rejects.toMatchObject({ code: 'P2002' })
  })
})
