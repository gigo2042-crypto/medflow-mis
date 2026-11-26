// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Складской контур v2 (ФТ-008): номенклатура, склады филиалов, остатки,
// приход/расход/списание, полноценные перемещения между складами (документ
// «черновик → в пути → принято») и инвентаризация (учёт против факта,
// излишки/недостачи проводками). Автосписание на визит — с основного склада.
// Минимальные остатки → уведомления через Центр уведомлений (ФТ-013).
// Серверный модуль — не импортировать в клиентский код!

import { db } from '@/lib/db'
import { staffAlert } from './notify'

// Стандартные наборы расходников по специализации (упрощённый аналог
// привязки к интерактивному шаблону протокола из ФТ-008)
export const STANDARD_KITS: Record<string, Array<{ sku: string; qty: number }>> = {
  'Стоматолог-терапевт': [
    { sku: 'STK-001', qty: 2 }, // перчатки
    { sku: 'STK-002', qty: 1 }, // анестетик
    { sku: 'STK-003', qty: 1 }, // пломбировочный материал
    { sku: 'STK-004', qty: 2 }, // салфетки
    { sku: 'STK-006', qty: 1 }, // игла
  ],
  'Стоматолог-хирург': [
    { sku: 'STK-001', qty: 2 },
    { sku: 'STK-002', qty: 2 },
    { sku: 'STK-006', qty: 2 },
    { sku: 'STK-007', qty: 1 }, // шовный материал
    { sku: 'STK-004', qty: 2 },
  ],
  'Стоматолог-ортопед': [
    { sku: 'STK-001', qty: 2 },
    { sku: 'STK-005', qty: 1 }, // оттискной материал
    { sku: 'STK-004', qty: 2 },
  ],
  'Терапевт': [
    { sku: 'STK-001', qty: 2 },
    { sku: 'STK-008', qty: 1 }, // спиртовые салфетки
  ],
  'Педиатр': [
    { sku: 'STK-001', qty: 2 },
    { sku: 'STK-008', qty: 1 },
  ],
}

export interface ConsumeResult {
  visitId: string
  consumed: Array<{ name: string; qty: number; cost: number }>
  totalCost: number
  lowStock: Array<{ name: string; qty: number; minQty: number }>
}

// ---------- Внутренние проводки ----------

// Основной склад (для автосписания на визит): MAIN → первый активный
export async function getMainWarehouseId(): Promise<string | null> {
  const main = await db.warehouse.findFirst({ where: { kind: 'MAIN', active: true } })
  if (main) return main.id
  const any = await db.warehouse.findFirst({ where: { active: true }, orderBy: { code: 'asc' } })
  return any?.id ?? null
}

async function getOrCreateBalance(itemId: string, warehouseId: string) {
  const existing = await db.stockBalance.findUnique({ where: { itemId_warehouseId: { itemId, warehouseId } } })
  if (existing) return existing
  return db.stockBalance.create({ data: { itemId, warehouseId, qty: 0 } })
}

// Смена остатка на складе; денормализованный итог по номенклатуре обновляется
async function adjustBalance(itemId: string, warehouseId: string, delta: number): Promise<number> {
  const bal = await getOrCreateBalance(itemId, warehouseId)
  const next = bal.qty + delta
  if (next < 0) {
    throw new Error('Недостаточно остатка на складе для операции')
  }
  await db.stockBalance.update({ where: { id: bal.id }, data: { qty: next } })
  await refreshItemTotal(itemId)
  return next
}

// StockItem.qty = сумма остатков по всем складам (денормализация v2)
async function refreshItemTotal(itemId: string): Promise<number> {
  const agg = await db.stockBalance.aggregate({ where: { itemId }, _sum: { qty: true } })
  const total = agg._sum.qty ?? 0
  await db.stockItem.update({ where: { id: itemId }, data: { qty: total } })
  return total
}

async function logMovement(input: {
  itemId: string
  warehouseId: string
  type: string
  qty: number
  price?: number
  note?: string
  userId?: string
  visitId?: string
  transferId?: string
  inventoryId?: string
}) {
  const item = await db.stockItem.findUnique({ where: { id: input.itemId } })
  await db.stockMovement.create({
    data: {
      itemId: input.itemId,
      type: input.type,
      qty: input.qty,
      price: input.price ?? item?.price ?? 0,
      note: input.note,
      userId: input.userId,
      visitId: input.visitId,
      warehouseId: input.warehouseId,
      transferId: input.transferId,
      inventoryId: input.inventoryId,
    },
  })
}

// Номер документа: ПМ-000001 / ИНВ-000001
async function nextNumber(prefix: 'ПМ' | 'ИНВ'): Promise<string> {
  const count =
    prefix === 'ПМ'
      ? await db.transferDoc.count()
      : await db.inventoryAct.count()
  return `${prefix}-${String(count + 1).padStart(6, '0')}`
}

// ---------- Приход / списание ----------

// Приход (приёмка партии) на указанный склад
export async function receiveStock(itemId: string, warehouseId: string, qty: number, note?: string, userId?: string): Promise<void> {
  const item = await db.stockItem.findUnique({ where: { id: itemId } })
  if (!item) throw new Error('Позиция склада не найдена')
  const wh = await db.warehouse.findUnique({ where: { id: warehouseId } })
  if (!wh || !wh.active) throw new Error('Склад не найден или отключён')
  await adjustBalance(itemId, warehouseId, qty)
  await logMovement({ itemId, warehouseId, type: 'IN', qty, note: note ?? `Приход на склад «${wh.name}»`, userId })
}

// Списание (брак, истёк срок) с указанного склада
export async function writeOffStock(itemId: string, warehouseId: string, qty: number, note?: string, userId?: string): Promise<void> {
  const item = await db.stockItem.findUnique({ where: { id: itemId } })
  if (!item) throw new Error('Позиция склада не найдена')
  const bal = await db.stockBalance.findUnique({ where: { itemId_warehouseId: { itemId, warehouseId } } })
  if (!bal || bal.qty < qty) {
    throw new Error(`Недостаточно на складе: ${bal?.qty ?? 0} из ${qty}`)
  }
  await adjustBalance(itemId, warehouseId, -qty)
  await logMovement({ itemId, warehouseId, type: 'WRITEOFF', qty, note: note ?? 'Списание: брак/истёк срок', userId })
}

// ---------- Перемещения между складами (ФТ-008) ----------

export interface TransferInputLine {
  itemId: string
  qty: number
}

// Создание документа перемещения (черновик): проверка остатков отправителя
export async function createTransfer(input: {
  fromWarehouseId: string
  toWarehouseId: string
  lines: TransferInputLine[]
  comment?: string
  createdBy?: string
}): Promise<{ id: string; number: string }> {
  if (input.fromWarehouseId === input.toWarehouseId) {
    throw new Error('Отправитель и получатель — один и тот же склад')
  }
  const lines = (input.lines || []).filter((l) => Number(l.qty) > 0)
  if (lines.length === 0) throw new Error('Добавьте хотя бы одну позицию с количеством > 0')
  const seen = new Set(lines.map((l) => l.itemId))
  if (seen.size !== lines.length) throw new Error('Дубли позиций в документе')

  for (const l of lines) {
    const bal = await db.stockBalance.findUnique({
      where: { itemId_warehouseId: { itemId: l.itemId, warehouseId: input.fromWarehouseId } },
    })
    if (!bal || bal.qty < l.qty) {
      const item = await db.stockItem.findUnique({ where: { id: l.itemId } })
      throw new Error(`Недостаточно на складе-отправителе: «${item?.name ?? l.itemId}» — ${bal?.qty ?? 0} из ${l.qty}`)
    }
  }

  const number = await nextNumber('ПМ')
  const doc = await db.transferDoc.create({
    data: {
      number,
      fromWarehouseId: input.fromWarehouseId,
      toWarehouseId: input.toWarehouseId,
      status: 'DRAFT',
      comment: input.comment,
      createdBy: input.createdBy,
      lines: { create: lines.map((l) => ({ itemId: l.itemId, qty: l.qty })) },
    },
  })
  return { id: doc.id, number: doc.number }
}

// Отправка: DRAFT → IN_TRANSIT — товар списывается со склада-отправителя
export async function dispatchTransfer(transferId: string, userId?: string): Promise<void> {
  const doc = await db.transferDoc.findUnique({ where: { id: transferId }, include: { lines: true } })
  if (!doc) throw new Error('Документ перемещения не найден')
  if (doc.status !== 'DRAFT') throw new Error('Отправить можно только черновик')
  for (const l of doc.lines) {
    const bal = await db.stockBalance.findUnique({
      where: { itemId_warehouseId: { itemId: l.itemId, warehouseId: doc.fromWarehouseId } },
    })
    if (!bal || bal.qty < l.qty) {
      const item = await db.stockItem.findUnique({ where: { id: l.itemId } })
      throw new Error(`Недостаточно для отправки: «${item?.name ?? l.itemId}» — ${bal?.qty ?? 0} из ${l.qty}`)
    }
    await adjustBalance(l.itemId, doc.fromWarehouseId, -l.qty)
    await logMovement({
      itemId: l.itemId,
      warehouseId: doc.fromWarehouseId,
      type: 'TRANSFER_OUT',
      qty: l.qty,
      note: `Перемещение ${doc.number} → склад-получатель`,
      userId,
      transferId: doc.id,
    })
  }
  await db.transferDoc.update({
    where: { id: transferId },
    data: { status: 'IN_TRANSIT', dispatchedAt: new Date() },
  })
}

// Приёмка: IN_TRANSIT → COMPLETED — товар приходуется на склад-получатель
export async function receiveTransfer(transferId: string, userId?: string): Promise<void> {
  const doc = await db.transferDoc.findUnique({ where: { id: transferId }, include: { lines: true, toWarehouse: true } })
  if (!doc) throw new Error('Документ перемещения не найден')
  if (doc.status !== 'IN_TRANSIT') throw new Error('Принять можно только перемещение «в пути»')
  for (const l of doc.lines) {
    await adjustBalance(l.itemId, doc.toWarehouseId, l.qty)
    await logMovement({
      itemId: l.itemId,
      warehouseId: doc.toWarehouseId,
      type: 'TRANSFER_IN',
      qty: l.qty,
      note: `Перемещение ${doc.number} со склада-отправителя`,
      userId,
      transferId: doc.id,
    })
  }
  await db.transferDoc.update({
    where: { id: transferId },
    data: { status: 'COMPLETED', completedAt: new Date() },
  })
}

// Отмена: черновик — просто отмена; «в пути» — возврат товара отправителю
export async function cancelTransfer(transferId: string, userId?: string): Promise<void> {
  const doc = await db.transferDoc.findUnique({ where: { id: transferId }, include: { lines: true } })
  if (!doc) throw new Error('Документ перемещения не найден')
  if (doc.status === 'COMPLETED') throw new Error('Принятое перемещение отменить нельзя')
  if (doc.status === 'DRAFT') {
    await db.transferDoc.update({ where: { id: transferId }, data: { status: 'CANCELED' } })
    return
  }
  if (doc.status === 'IN_TRANSIT') {
    for (const l of doc.lines) {
      await adjustBalance(l.itemId, doc.fromWarehouseId, l.qty)
      await logMovement({
        itemId: l.itemId,
        warehouseId: doc.fromWarehouseId,
        type: 'TRANSFER_IN',
        qty: l.qty,
        note: `Возврат по отмене перемещения ${doc.number}`,
        userId,
        transferId: doc.id,
      })
    }
    await db.transferDoc.update({ where: { id: transferId }, data: { status: 'CANCELED' } })
    return
  }
  throw new Error('Перемещение уже отменено')
}

// ---------- Инвентаризация (ФТ-008) ----------

// Создание акта: снимок учётных остатков склада в строки
export async function createInventory(input: {
  warehouseId: string
  comment?: string
  createdBy?: string
}): Promise<{ id: string; number: string }> {
  const wh = await db.warehouse.findUnique({ where: { id: input.warehouseId } })
  if (!wh || !wh.active) throw new Error('Склад не найден или отключён')
  const balances = await db.stockBalance.findMany({
    where: { warehouseId: input.warehouseId },
    orderBy: { itemId: 'asc' },
  })
  if (balances.length === 0) throw new Error('На складе нет номенклатуры для инвентаризации')

  const number = await nextNumber('ИНВ')
  const act = await db.inventoryAct.create({
    data: {
      number,
      warehouseId: input.warehouseId,
      status: 'OPEN',
      comment: input.comment,
      createdBy: input.createdBy,
      lines: { create: balances.map((b) => ({ itemId: b.itemId, accountedQty: b.qty })) },
    },
  })
  return { id: act.id, number: act.number }
}

// Ввод фактических остатков (поштучно)
export async function saveInventoryFact(
  actId: string,
  facts: Array<{ lineId: string; factQty: number }>
): Promise<number> {
  const act = await db.inventoryAct.findUnique({ where: { id: actId }, include: { lines: true } })
  if (!act) throw new Error('Акт инвентаризации не найден')
  if (act.status !== 'OPEN') throw new Error('Акт уже проведён')
  let saved = 0
  for (const f of facts) {
    const line = act.lines.find((l) => l.id === f.lineId)
    if (!line) continue
    if (!Number.isInteger(f.factQty) || f.factQty < 0) {
      throw new Error('Факт — целое число, не меньше нуля')
    }
    await db.inventoryLine.update({ where: { id: line.id }, data: { factQty: f.factQty } })
    saved++
  }
  return saved
}

// Проведение: расхождения закрываются проводками (излишки/недостачи)
export async function completeInventory(actId: string, userId?: string): Promise<{
  surplusCost: number
  shortageCost: number
  adjustedLines: number
}> {
  const act = await db.inventoryAct.findUnique({
    where: { id: actId },
    include: { lines: { include: { item: true } }, warehouse: true },
  })
  if (!act) throw new Error('Акт инвентаризации не найден')
  if (act.status !== 'OPEN') throw new Error('Акт уже проведён')

  let surplusCost = 0
  let shortageCost = 0
  let adjustedLines = 0

  for (const line of act.lines) {
    if (line.factQty === null) continue // не посчитано — не корректируем
    const diff = line.factQty - line.accountedQty
    if (diff === 0) continue
    const cost = Math.abs(diff) * line.item.price
    if (diff > 0) {
      surplusCost += cost
      await adjustBalance(line.itemId, act.warehouseId, diff)
      await logMovement({
        itemId: line.itemId,
        warehouseId: act.warehouseId,
        type: 'ADJ_IN',
        qty: diff,
        note: `Инвентаризация ${act.number}: излишек (+${diff})`,
        userId,
        inventoryId: act.id,
      })
    } else {
      shortageCost += cost
      await adjustBalance(line.itemId, act.warehouseId, diff)
      await logMovement({
        itemId: line.itemId,
        warehouseId: act.warehouseId,
        type: 'ADJ_OUT',
        qty: -diff,
        note: `Инвентаризация ${act.number}: недостача (${diff})`,
        userId,
        inventoryId: act.id,
      })
    }
    adjustedLines++
  }

  await db.inventoryAct.update({
    where: { id: actId },
    data: { status: 'COMPLETED', completedAt: new Date(), surplusCost, shortageCost },
  })
  return { surplusCost, shortageCost, adjustedLines }
}

// ---------- Автосписание на визит (ФТ-008) ----------

// Автосписание расходников на визит: набор по специализации врача,
// списывается с основного склада. Идемпотентно — по одному списанию на визит.
export async function consumeForVisit(visitId: string): Promise<ConsumeResult | null> {
  const visit = await db.visit.findUnique({ where: { id: visitId }, include: { doctor: true } })
  if (!visit) return null
  const existing = await db.stockMovement.findFirst({ where: { visitId, type: 'OUT' } })
  if (existing) return null // уже списано

  const mainId = await getMainWarehouseId()
  if (!mainId) return null // склады не инициализированы

  const kit = STANDARD_KITS[visit.doctor.specialty] || STANDARD_KITS['Терапевт']
  const consumed: ConsumeResult['consumed'] = []
  const lowStock: ConsumeResult['lowStock'] = []
  let totalCost = 0

  for (const line of kit) {
    const item = await db.stockItem.findUnique({ where: { sku: line.sku } })
    if (!item) continue
    const bal = await db.stockBalance.findUnique({
      where: { itemId_warehouseId: { itemId: item.id, warehouseId: mainId } },
    })
    if (!bal || bal.qty < line.qty) continue // не хватает на основном складе
    const qtyAfter = await adjustBalance(item.id, mainId, -line.qty)
    const cost = line.qty * item.price
    totalCost += cost
    await db.stockMovement.create({
      data: {
        itemId: item.id,
        type: 'OUT',
        qty: line.qty,
        price: item.price,
        visitId,
        warehouseId: mainId,
        note: `Автосписание: приём ${visit.doctor.specialty}`,
      },
    })
    consumed.push({ name: item.name, qty: line.qty, cost })
    if (qtyAfter < item.minQty) lowStock.push({ name: item.name, qty: qtyAfter, minQty: item.minQty })
  }

  // Минимальные остатки → уведомление в Центр уведомлений (ФТ-008 + ФТ-013)
  for (const low of lowStock) {
    await staffAlert('STOCK_LOW', `Склад: «${low.name}» ниже минимума — осталось ${low.qty} при норме ${low.minQty}. Оформите приход.`)
  }

  return { visitId, consumed, totalCost, lowStock }
}
