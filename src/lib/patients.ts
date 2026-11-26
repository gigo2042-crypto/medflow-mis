// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

/** Создание пациента с уникальным номером карты MF-NNNN (повтор при гонке по уникальному индексу). */
type Tx = Prisma.TransactionClient | typeof db

/** Последовательность номеров карт — на текущий максимум MF-NNNN (после импорта, ручных номеров, сида). */
export async function syncCardSequence(tx: Tx = db): Promise<void> {
  await tx.$queryRaw`SELECT setval('patient_card_seq', GREATEST(1000, COALESCE((
    SELECT MAX(CAST(SUBSTRING("cardNumber" FROM 4) AS BIGINT)) FROM "Patient" WHERE "cardNumber" ~ '^MF-[0-9]+$'
  ), 1000)), true)`
}

/**
 * Следующий свободный номер карты MF-NNNN. Единственная реализация нумерации (регистратура, виджет, импорт):
 * nextval последовательности patient_card_seq; занятый номер (ручной/импортированный) — досинхронизация
 * без ошибки внутри транзакции.
 */
export async function nextCardNumber(tx: Tx = db): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [{ n }] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('patient_card_seq') AS n`
    const card = `MF-${n}`
    const taken = await tx.patient.findUnique({ where: { cardNumber: card }, select: { id: true } })
    if (!taken) return card
    await syncCardSequence(tx)
  }
  throw new Error('Не удалось выдать номер карты')
}

export async function createPatientWithCard(data: Omit<Prisma.PatientCreateInput, 'cardNumber'>, tx: Tx = db) {
  return tx.patient.create({ data: { ...data, cardNumber: await nextCardNumber(tx) } })
}

/**
 * Поиск пациента для онлайн-записи: телефон (нормализованный, по индексу mf_phone_norm) И фамилия.
 * Только по телефону не связываем — одним номером часто пользуется семья, и запись ребёнка
 * не должна попасть в медкарту родителя. Обезличенные карты не участвуют.
 */
export async function findPatientForBooking(phoneNorm: string, fullName: string, tx: Tx = db): Promise<{ id: string } | null> {
  const lastName = fullName.trim().split(/\s+/)[0] || ''
  if (!phoneNorm || !lastName) return null
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Patient"
     WHERE mf_phone_norm(phone) = ${phoneNorm} AND "anonymizedAt" IS NULL
       AND lower(replace("lastName", 'ё', 'е')) = lower(replace(${lastName}, 'ё', 'е'))
     ORDER BY "createdAt" ASC LIMIT 1`
  return rows[0] ?? null
}
