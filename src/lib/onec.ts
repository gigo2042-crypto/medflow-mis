// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Выгрузки в 1С (ИНТ-006, складской контур): пакеты CommerceML-подобного XML —
// номенклатура, остатки по складам, документы движений за период. Обмен
// 1С:HTTP-сервисами/OData имитируется очередью OneCExport (3 попытки на пакет,
// подтверждение от «1С»), файловый XML доступен для скачивания.
// Серверный модуль — не импортировать в клиентский код!

import { db } from '@/lib/db'
import { isDemo } from '@/lib/config'
import { zonedParts } from './mis-utils'

export type OneCScope = 'NOMENCLATURE' | 'BALANCES' | 'DOCS'

const esc = (s: string | number | null | undefined): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const isoDate = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0')
  const z = zonedParts(d)
  return `${z.year}-${p(z.month)}-${p(z.day)}T${p(z.hour)}:${p(z.minute)}:${p(z.second)}`
}

export interface OneCExportData {
  xml: string
  docsCount: number
  size: number
}

// Сборка пакета XML по области выгрузки
export async function buildOneCExport(scope: OneCScope, from: Date, to: Date): Promise<OneCExportData> {
  const header = `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.08" ДатаФормирования="${isoDate(new Date())}" ФорматДаты="ISO8601" ДатаНачалаПериода="${isoDate(from)}" ДатаКонцаПериода="${isoDate(to)}">`

  const parts: string[] = []

  if (scope === 'NOMENCLATURE') {
    const items = await db.stockItem.findMany({ where: { active: true }, orderBy: { sku: 'asc' } })
    parts.push(`  <КаталогТМЦ>
    <Идентификатор>${esc('МИС-СКЛАД')}</Идентификатор>
    <Наименование>Номенклатура расходных материалов клиники</Наименование>
    <Владелец>MedFlow МИС</Владелец>`)
    for (const i of items) {
      parts.push(`    <Товар>
      <Идентификатор>${esc(i.sku)}</Идентификатор>
      <Наименование>${esc(i.name)}</Наименование>
      <ЕдиницаИзмерения>${esc(i.unit)}</ЕдиницаИзмерения>
      <Артикул>${esc(i.sku)}</Артикул>
      <Категория>${esc(i.category)}</Категория>
      <ЦенаЗакупки>${i.price}</ЦенаЗакупки>
      <НормаМинимум>${i.minQty}</НормаМинимум>
    </Товар>`)
    }
    parts.push('  </КаталогТМЦ>')
  }

  if (scope === 'BALANCES') {
    const balances = await db.stockBalance.findMany({
      where: { qty: { gt: 0 } },
      include: { item: true, warehouse: true },
      orderBy: { warehouseId: 'asc' },
    })
    const grouped = new Map<string, typeof balances>()
    for (const b of balances) {
      const list = grouped.get(b.warehouseId) ?? []
      list.push(b)
      grouped.set(b.warehouseId, list)
    }
    for (const [whId, rows] of grouped) {
      const wh = rows[0].warehouse
      parts.push(`  <ОстаткиТоваров>
    <Склад>
      <Идентификатор>${esc(wh.code)}</Идентификатор>
      <Наименование>${esc(wh.name)}</Наименование>
    </Склад>`)
      for (const b of rows) {
        parts.push(`    <Остаток>
      <Номенклатура>
        <Идентификатор>${esc(b.item.sku)}</Идентификатор>
        <Наименование>${esc(b.item.name)}</Наименование>
      </Номенклатура>
      <Количество>${b.qty}</Количество>
      <ЦенаЗакупки>${b.item.price}</ЦенаЗакупки>
      <Стоимость>${b.qty * b.item.price}</Стоимость>
    </Остаток>`)
      }
      parts.push('  </ОстаткиТоваров>')
    }
  }

  if (scope === 'DOCS') {
    // Документы движений за период: приходы, списания, перемещения, инвентаризации
    const movements = await db.stockMovement.findMany({
      where: { createdAt: { gte: from, lte: to }, type: { in: ['IN', 'WRITEOFF'] } },
      include: { item: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    })
    let docNo = 1
    for (const m of movements) {
      const tag = m.type === 'IN' ? 'ПоступлениеТоваров' : 'СписаниеТоваров'
      parts.push(`  <Документ Номер="${docNo}" Тип="${tag}">
    <НомерДок>${docNo}</НомерДок>
    <ДатаДок>${isoDate(m.createdAt)}</ДатаДок>
    <Склад>${esc(m.warehouseId ? 'по складу МИС' : 'склад не указан')}</Склад>
    <Номенклатура>
      <Идентификатор>${esc(m.item.sku)}</Идентификатор>
      <Наименование>${esc(m.item.name)}</Наименование>
    </Номенклатура>
    <Количество>${m.qty}</Количество>
    <Цена>${m.price}</Цена>
    <Сумма>${m.qty * m.price}</Сумма>
    <Комментарий>${esc(m.note ?? '')}</Комментарий>
  </Документ>`)
      docNo++
    }

    const transfers = await db.transferDoc.findMany({
      where: { createdAt: { gte: from, lte: to }, status: { in: ['COMPLETED', 'IN_TRANSIT'] } },
      include: { fromWarehouse: true, toWarehouse: true, lines: { include: { item: true } } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    })
    for (const t of transfers) {
      parts.push(`  <Документ Номер="${t.number}" Тип="ПеремещениеТоваров">
    <НомерДок>${esc(t.number)}</НомерДок>
    <ДатаДок>${isoDate(t.createdAt)}</ДатаДок>
    <СкладОтправитель>
      <Идентификатор>${esc(t.fromWarehouse.code)}</Идентификатор>
      <Наименование>${esc(t.fromWarehouse.name)}</Наименование>
    </СкладОтправитель>
    <СкладПолучатель>
      <Идентификатор>${esc(t.toWarehouse.code)}</Идентификатор>
      <Наименование>${esc(t.toWarehouse.name)}</Наименование>
    </СкладПолучатель>
    <Статус>${esc(t.status === 'COMPLETED' ? 'Проведён' : 'В пути')}</Статус>`)
      for (const l of t.lines) {
        parts.push(`    <Строка>
      <Номенклатура>
        <Идентификатор>${esc(l.item.sku)}</Идентификатор>
        <Наименование>${esc(l.item.name)}</Наименование>
      </Номенклатура>
      <Количество>${l.qty}</Количество>
    </Строка>`)
      }
      parts.push(`    <Комментарий>${esc(t.comment ?? '')}</Комментарий>
  </Документ>`)
    }

    const inventories = await db.inventoryAct.findMany({
      where: { createdAt: { gte: from, lte: to }, status: 'COMPLETED' },
      include: { warehouse: true, lines: { include: { item: true } } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    })
    for (const inv of inventories) {
      parts.push(`  <Документ Номер="${inv.number}" Тип="ИнвентаризацияТоваров">
    <НомерДок>${esc(inv.number)}</НомерДок>
    <ДатаДок>${isoDate(inv.createdAt)}</ДатаДок>
    <Склад>
      <Идентификатор>${esc(inv.warehouse.code)}</Идентификатор>
      <Наименование>${esc(inv.warehouse.name)}</Наименование>
    </Склад>
    <ИзлишкиСтоимость>${inv.surplusCost}</ИзлишкиСтоимость>
    <НедостачиСтоимость>${inv.shortageCost}</НедостачиСтоимость>`)
      for (const l of inv.lines) {
        if (l.factQty === null || l.factQty === l.accountedQty) continue
        const diff = l.factQty - l.accountedQty
        parts.push(`    <Строка>
      <Номенклатура>
        <Идентификатор>${esc(l.item.sku)}</Идентификатор>
        <Наименование>${esc(l.item.name)}</Наименование>
      </Номенклатура>
      <КоличествоУчёт>${l.accountedQty}</КоличествоУчёт>
      <КоличествоФакт>${l.factQty}</КоличествоФакт>
      <Расхождение>${diff}</Расхождение>
    </Строка>`)
      }
      parts.push('  </Документ>')
    }
  }

  const xml = `${header}
${parts.join('\n')}
</КоммерческаяИнформация>`

  // docsCount: грубые «документы» — узлы верхнего уровня
  const docsCount = parts.filter((p) => p.includes('<Документ ') || p.includes('<Каталог') || p.includes('<ОстаткиТоваров>')).length

  return { xml, docsCount, size: Buffer.byteLength(xml, 'utf8') }
}

// Обработка очереди выгрузок (ИНТ-006): 3 попытки на пакет; демо-«1С»
// подтверждает ~90% пакетов, остальные ждут следующего тика.
export interface OneCProcessResult {
  sent: number
  confirmed: number
  retried: number
  failed: number
}

export async function processOneCQueue(): Promise<OneCProcessResult> {
  const res: OneCProcessResult = { sent: 0, confirmed: 0, retried: 0, failed: 0 }
  // Подтверждения «1С» имитируются только на демо-стенде; в production пакеты
  // скачиваются бухгалтерией вручную (XML) до подключения реального обмена.
  if (!isDemo()) return res
  const queue = await db.oneCExport.findMany({ where: { status: { in: ['QUEUED', 'SENT'] } }, orderBy: { createdAt: 'asc' }, take: 20 })
  const now = new Date()

  for (const ex of queue) {
    if (ex.status === 'QUEUED') {
      await db.oneCExport.update({ where: { id: ex.id }, data: { status: 'SENT', sentAt: now, attempts: ex.attempts + 1 } })
      res.sent++
      continue
    }
    // SENT → ждём подтверждение «1С»: демо 90% успеха
    const ok = Math.random() < 0.9
    if (ok) {
      await db.oneCExport.update({ where: { id: ex.id }, data: { status: 'CONFIRMED', confirmedAt: now, error: null } })
      res.confirmed++
    } else if (ex.attempts >= 3) {
      await db.oneCExport.update({
        where: { id: ex.id },
        data: { status: 'ERROR', error: '1С не подтвердил пакет: попытки исчерпаны' },
      })
      res.failed++
    } else {
      await db.oneCExport.update({
        where: { id: ex.id },
        data: { attempts: ex.attempts + 1, error: `1С не подтвердил пакет — повтор №${ex.attempts + 1}` },
      })
      res.retried++
    }
  }
  return res
}
