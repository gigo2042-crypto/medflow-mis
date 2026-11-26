// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, requirePerm } from '@/lib/auth-server'
import { clinicDayStart } from '@/lib/mis-utils'
import {
  cancelTransfer, completeInventory, createInventory, createTransfer,
  dispatchTransfer, receiveStock, receiveTransfer, saveInventoryFact, writeOffStock,
  STANDARD_KITS,
} from '@/lib/stock'

export const dynamic = 'force-dynamic'

// Складской контур v2 (ФТ-008): склады филиалов, остатки по складам,
// полноценные перемещения (черновик → в пути → принято), инвентаризация
// (учёт против факта, излишки/недостачи), журнал движений ТМЦ (ОТЧ-24).

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'stock.read')
  if (!g.ok) return g.res
  try {
    const [warehouses, items, balances, movements, transfers, inventories] = await Promise.all([
      db.warehouse.findMany({ where: { active: true }, orderBy: { code: 'asc' } }),
      db.stockItem.findMany({ where: { active: true }, orderBy: [{ category: 'asc' }, { name: 'asc' }] }),
      db.stockBalance.findMany(),
      db.stockMovement.findMany({
        orderBy: { createdAt: 'desc' },
        take: 250,
        include: { item: { select: { name: true, unit: true, sku: true } } },
      }),
      db.transferDoc.findMany({
        orderBy: { createdAt: 'desc' },
        take: 60,
        include: { fromWarehouse: true, toWarehouse: true, lines: { include: { item: true } } },
      }),
      db.inventoryAct.findMany({
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: { warehouse: true, lines: { include: { item: true } } },
      }),
    ])

    const whById = new Map(warehouses.map((w) => [w.id, w]))
    const balancesByItem = new Map<string, Map<string, number>>()
    for (const b of balances) {
      const row = balancesByItem.get(b.itemId) ?? new Map<string, number>()
      row.set(b.warehouseId, b.qty)
      balancesByItem.set(b.itemId, row)
    }

    const itemDTOs = items.map((i) => {
      const perWh = balancesByItem.get(i.id) ?? new Map<string, number>()
      const total = [...perWh.values()].reduce((s, q) => s + q, 0)
      return {
        id: i.id,
        sku: i.sku,
        name: i.name,
        category: i.category,
        unit: i.unit,
        price: i.price,
        minQty: i.minQty,
        balances: warehouses.map((w) => ({ warehouseId: w.id, qty: perWh.get(w.id) ?? 0 })),
        total,
        value: total * i.price,
        belowMin: total < i.minQty,
      }
    })

    const warehouseDTOs = warehouses.map((w) => {
      let count = 0
      let value = 0
      for (const i of items) {
        const qty = balancesByItem.get(i.id)?.get(w.id) ?? 0
        if (qty > 0) {
          count++
          value += qty * i.price
        }
      }
      return { id: w.id, code: w.code, name: w.name, address: w.address, kind: w.kind, active: w.active, itemsCount: count, totalValue: value }
    })

    const movementDTOs = movements.map((m) => ({
      id: m.id,
      type: m.type,
      qty: m.qty,
      price: m.price,
      cost: m.qty * m.price,
      note: m.note,
      visitId: m.visitId,
      createdAt: m.createdAt.toISOString(),
      itemName: m.item.name,
      itemUnit: m.item.unit,
      itemSku: m.item.sku,
      warehouseId: m.warehouseId,
      warehouseName: m.warehouseId ? whById.get(m.warehouseId)?.name ?? null : null,
      transferId: m.transferId,
      inventoryId: m.inventoryId,
    }))

    const transferDTOs = transfers.map((t) => ({
      id: t.id,
      number: t.number,
      status: t.status,
      fromWarehouseId: t.fromWarehouseId,
      fromWarehouseName: t.fromWarehouse.name,
      toWarehouseId: t.toWarehouseId,
      toWarehouseName: t.toWarehouse.name,
      comment: t.comment,
      createdBy: t.createdBy,
      createdAt: t.createdAt.toISOString(),
      dispatchedAt: iso(t.dispatchedAt),
      completedAt: iso(t.completedAt),
      lines: t.lines.map((l) => ({
        id: l.id,
        itemId: l.itemId,
        name: l.item.name,
        sku: l.item.sku,
        unit: l.item.unit,
        qty: l.qty,
      })),
    }))

    const inventoryDTOs = inventories.map((a) => ({
      id: a.id,
      number: a.number,
      warehouseId: a.warehouseId,
      warehouseName: a.warehouse.name,
      status: a.status,
      comment: a.comment,
      createdBy: a.createdBy,
      createdAt: a.createdAt.toISOString(),
      completedAt: iso(a.completedAt),
      surplusCost: a.surplusCost,
      shortageCost: a.shortageCost,
      lines: a.lines.map((l) => ({
        id: l.id,
        itemId: l.itemId,
        name: l.item.name,
        sku: l.item.sku,
        unit: l.item.unit,
        accountedQty: l.accountedQty,
        factQty: l.factQty,
      })),
    }))

    const dayStart = clinicDayStart(0)
    const completedActs = inventories.filter((a) => a.status === 'COMPLETED')
    const stats = {
      items: items.length,
      belowMin: itemDTOs.filter((i) => i.belowMin).length,
      totalValue: itemDTOs.reduce((s, i) => s + i.value, 0),
      consumedToday: movements
        .filter((m) => m.type === 'OUT' && m.createdAt >= dayStart)
        .reduce((s, m) => s + m.qty * m.price, 0),
      warehouses: warehouses.length,
      transfersInTransit: transfers.filter((t) => t.status === 'IN_TRANSIT').length,
      inventoryOpen: inventories.filter((a) => a.status === 'OPEN').length,
      inventorySurplus: completedActs.reduce((s, a) => s + a.surplusCost, 0),
      inventoryShortage: completedActs.reduce((s, a) => s + a.shortageCost, 0),
    }

    return NextResponse.json({
      warehouses: warehouseDTOs,
      items: itemDTOs,
      movements: movementDTOs,
      transfers: transferDTOs,
      inventories: inventoryDTOs,
      stats,
      kits: Object.entries(STANDARD_KITS).map(([specialty, lines]) => ({
        specialty,
        items: lines.map((l) => l.sku),
      })),
    })
  } catch (e) {
    console.error('[stock GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить склад' }, { status: 500 })
  }
}

// Действия склада (ФТ-008): приход, списание, перемещения, инвентаризация
export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'stock.manage')
  if (!g.ok) return g.res
  try {
    const body = await req.json()
    const action = body.action
    const qty = Number(body.qty)

    if (action === 'RECEIVE') {
      if (!body.itemId || !body.warehouseId) return NextResponse.json({ error: 'Укажите позицию и склад' }, { status: 400 })
      if (!Number.isInteger(qty) || qty <= 0) return NextResponse.json({ error: 'Количество — целое число больше нуля' }, { status: 400 })
      await receiveStock(body.itemId, body.warehouseId, qty, body.note || undefined, g.user.id)
      await audit('stock.received', g.user.id, { itemId: body.itemId, warehouseId: body.warehouseId, qty })
      return NextResponse.json({ ok: true })
    }

    if (action === 'WRITE_OFF') {
      if (!body.itemId || !body.warehouseId) return NextResponse.json({ error: 'Укажите позицию и склад' }, { status: 400 })
      if (!Number.isInteger(qty) || qty <= 0) return NextResponse.json({ error: 'Количество — целое число больше нуля' }, { status: 400 })
      await writeOffStock(body.itemId, body.warehouseId, qty, body.note || 'Списание: брак/истёк срок', g.user.id)
      await audit('stock.written_off', g.user.id, { itemId: body.itemId, warehouseId: body.warehouseId, qty, note: body.note })
      return NextResponse.json({ ok: true })
    }

    // ---------- Перемещения между складами (ФТ-008) ----------

    if (action === 'TRANSFER_CREATE') {
      const lines = (body.lines || []) as Array<{ itemId: string; qty: number }>
      const cleaned = lines.filter((l) => Number(l.qty) > 0).map((l) => ({ itemId: l.itemId, qty: Number(l.qty) }))
      if (!body.fromWarehouseId || !body.toWarehouseId) return NextResponse.json({ error: 'Укажите склады отправителя и получателя' }, { status: 400 })
      if (cleaned.length === 0) return NextResponse.json({ error: 'Добавьте позиции с количеством > 0' }, { status: 400 })
      const res = await createTransfer({
        fromWarehouseId: body.fromWarehouseId,
        toWarehouseId: body.toWarehouseId,
        lines: cleaned,
        comment: body.comment || undefined,
        createdBy: g.user.name,
      })
      await audit('stock.transfer_created', g.user.id, { number: res.number, lines: cleaned })
      return NextResponse.json({ ok: true, ...res })
    }

    if (action === 'TRANSFER_DISPATCH') {
      if (!body.transferId) return NextResponse.json({ error: 'Укажите transferId' }, { status: 400 })
      await dispatchTransfer(body.transferId, g.user.id)
      await audit('stock.transfer_dispatched', g.user.id, { transferId: body.transferId })
      return NextResponse.json({ ok: true })
    }

    if (action === 'TRANSFER_RECEIVE') {
      if (!body.transferId) return NextResponse.json({ error: 'Укажите transferId' }, { status: 400 })
      await receiveTransfer(body.transferId, g.user.id)
      await audit('stock.transfer_received', g.user.id, { transferId: body.transferId })
      return NextResponse.json({ ok: true })
    }

    if (action === 'TRANSFER_CANCEL') {
      if (!body.transferId) return NextResponse.json({ error: 'Укажите transferId' }, { status: 400 })
      await cancelTransfer(body.transferId, g.user.id)
      await audit('stock.transfer_canceled', g.user.id, { transferId: body.transferId })
      return NextResponse.json({ ok: true })
    }

    // ---------- Инвентаризация (ФТ-008) ----------

    if (action === 'INVENTORY_CREATE') {
      if (!body.warehouseId) return NextResponse.json({ error: 'Укажите склад' }, { status: 400 })
      const res = await createInventory({ warehouseId: body.warehouseId, comment: body.comment || undefined, createdBy: g.user.name })
      await audit('stock.inventory_created', g.user.id, { number: res.number, warehouseId: body.warehouseId })
      return NextResponse.json({ ok: true, ...res })
    }

    if (action === 'INVENTORY_SAVE_FACT') {
      if (!body.actId) return NextResponse.json({ error: 'Укажите actId' }, { status: 400 })
      const facts = (body.facts || []) as Array<{ lineId: string; factQty: number }>
      if (facts.length === 0) return NextResponse.json({ error: 'Передайте фактические остатки' }, { status: 400 })
      const saved = await saveInventoryFact(body.actId, facts)
      await audit('stock.inventory_facts_saved', g.user.id, { actId: body.actId, saved })
      return NextResponse.json({ ok: true, saved })
    }

    if (action === 'INVENTORY_COMPLETE') {
      if (!body.actId) return NextResponse.json({ error: 'Укажите actId' }, { status: 400 })
      const res = await completeInventory(body.actId, g.user.id)
      await audit('stock.inventory_completed', g.user.id, { actId: body.actId, ...res })
      return NextResponse.json({ ok: true, ...res })
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 })
  } catch (e) {
    if (e instanceof Error) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error('[stock POST]', e)
    return NextResponse.json({ error: 'Не удалось выполнить действие' }, { status: 500 })
  }
}
