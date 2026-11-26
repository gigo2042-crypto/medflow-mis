// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '@/lib/api'
import { Me, can } from '@/lib/rbac'
import {
  INVENTORY_STATUS_LABELS,
  InventoryActDTO,
  STOCK_MOVEMENT_LABELS,
  StockBalanceDTO,
  StockMovementDTO,
  StockStats,
  TRANSFER_STATUS_LABELS,
  TransferDocDTO,
  WarehouseDTO,
} from '@/lib/types'
import { ddmmHHMM, pad2 } from '@/lib/mis-utils'
import { toast } from 'sonner'
import {
  ArrowRight,
  ArrowRightLeft,
  Boxes,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  TrendingDown,
  Truck,
  Wallet,
  Warehouse,
  X,
} from 'lucide-react'

// ---- Контракт GET /api/stock (складской контур v2, ФТ-008) ----
interface StockData {
  warehouses: WarehouseDTO[]
  items: StockBalanceDTO[]
  movements: StockMovementDTO[]
  transfers: TransferDocDTO[]
  inventories: InventoryActDTO[]
  stats: StockStats
}

interface OkRes {
  ok: boolean
}

interface NumberedRes {
  ok: boolean
  id: string
  number: string
}

interface InvSaveRes {
  ok: boolean
  saved: number
}

interface InvCompleteRes {
  ok: boolean
  surplusCost: number
  shortageCost: number
  adjustedLines: number
}

type TransferAction = 'TRANSFER_DISPATCH' | 'TRANSFER_RECEIVE' | 'TRANSFER_CANCEL'

interface TransferLineDraft {
  itemId: string
  qty: string
}

function fmtMoney(n: number): string {
  return `${n.toLocaleString('ru-RU')} ₽`
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return `${ddmmHHMM(d)}`
}

// Палитра бейджей — только emerald/teal/amber/rose/slate (без синих оттенков)
function movementClass(type: string): string {
  switch (type) {
    case 'IN':
      return 'bg-emerald-100 text-emerald-700'
    case 'OUT':
      return 'bg-teal-100 text-teal-700'
    case 'WRITEOFF':
      return 'bg-rose-100 text-rose-700'
    case 'TRANSFER_IN':
      return 'bg-emerald-100 text-emerald-700'
    case 'TRANSFER_OUT':
      return 'bg-slate-100 text-slate-600'
    case 'ADJ_IN':
      return 'bg-emerald-100 text-emerald-700'
    case 'ADJ_OUT':
      return 'bg-rose-100 text-rose-700'
    case 'INVENTORY':
      return 'bg-amber-100 text-amber-800'
    default:
      return 'bg-slate-100 text-slate-600'
  }
}

function transferStatusClass(status: string): string {
  switch (status) {
    case 'DRAFT':
      return 'bg-slate-100 text-slate-600'
    case 'IN_TRANSIT':
      return 'bg-amber-100 text-amber-800'
    case 'COMPLETED':
      return 'bg-emerald-100 text-emerald-700'
    case 'CANCELED':
      return 'bg-rose-100 text-rose-700'
    default:
      return 'bg-slate-100 text-slate-500'
  }
}

function linesSummary(t: TransferDocDTO): string {
  const first = t.lines.slice(0, 2).map((l) => l.name).join(', ')
  const rest = t.lines.length > 2 ? ` +${t.lines.length - 2}` : ''
  return `${first || '—'}${rest}`
}

// Складской контур v2 (ФТ-008): мульти-склад с матрицей остатков, приход/списание,
// перемещения между складами и инвентаризация — полноценные документы с проводками;
// автосписание на визит — с основного склада; минимальные остатки — в Центр
// уведомлений (ФТ-013).
export default function Stock({ me }: { me: Me }) {
  const canManage = can(me, 'stock.manage')
  const [data, setData] = useState<StockData | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // ---- Форма прихода (приёмка партии) ----
  const [recvWh, setRecvWh] = useState('')
  const [recvItem, setRecvItem] = useState('')
  const [recvQty, setRecvQty] = useState('50')
  const [recvNote, setRecvNote] = useState('Приёмка партии поставщика')

  // ---- Форма списания (брак / срок) ----
  const [offWh, setOffWh] = useState('')
  const [offItem, setOffItem] = useState('')
  const [offQty, setOffQty] = useState('5')
  const [offNote, setOffNote] = useState('Истёк срок годности')

  // ---- Форма перемещения ----
  const [trFrom, setTrFrom] = useState('')
  const [trTo, setTrTo] = useState('')
  const [trComment, setTrComment] = useState('')
  const [trLines, setTrLines] = useState<TransferLineDraft[]>([{ itemId: '', qty: '10' }])

  // ---- Раскрытые детали перемещений ----
  const [openTr, setOpenTr] = useState<Record<string, boolean>>({})

  // ---- Форма акта инвентаризации ----
  const [invWh, setInvWh] = useState('')
  const [invComment, setInvComment] = useState('')

  // ---- Редактор факта инвентаризации: локальные вводы по строкам акта ----
  const [factInputs, setFactInputs] = useState<Record<string, string>>({})
  const [confirmAct, setConfirmAct] = useState<InventoryActDTO | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api<StockData>('/api/stock')
      setData(d)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
    const poll = setInterval(load, 15000)
    return () => clearInterval(poll)
  }, [load])

  // Первый активный склад подставляется в селекты по умолчанию
  useEffect(() => {
    if (!data || data.warehouses.length === 0) return
    const main = data.warehouses.find((w) => w.active) ?? data.warehouses[0]
    setRecvWh((v) => v || main.id)
    setOffWh((v) => v || main.id)
    setTrFrom((v) => v || main.id)
    setInvWh((v) => v || main.id)
  }, [data])

  // Локальные значения факта инициализируются из акта (null → пусто, «не посчитано»)
  useEffect(() => {
    if (!data) return
    setFactInputs((prev) => {
      let changed = false
      const next = { ...prev }
      for (const a of data.inventories) {
        if (a.status !== 'OPEN') continue
        for (const l of a.lines) {
          if (!(l.id in next)) {
            next[l.id] = l.factQty == null ? '' : String(l.factQty)
            changed = true
          }
        }
      }
      return changed ? next : prev
    })
  }, [data])

  // Единая отправка POST /api/stock с индикатором занятости по ключу действия
  const post = async <T,>(key: string, body: Record<string, unknown>): Promise<T | null> => {
    if (busy !== null) return null
    setBusy(key)
    try {
      return await api<T>('/api/stock', { method: 'POST', body: JSON.stringify(body) })
    } catch (e) {
      toast.error((e as Error).message)
      return null
    } finally {
      setBusy(null)
    }
  }

  // ---- Приёмка партии (проводка IN) ----
  const receive = async (): Promise<void> => {
    if (!recvWh || !recvItem) {
      toast.error('Выберите склад и позицию для прихода')
      return
    }
    const qty = Number(recvQty)
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error('Количество прихода должно быть больше нуля')
      return
    }
    const res = await post<OkRes>('receive', {
      action: 'RECEIVE',
      itemId: recvItem,
      warehouseId: recvWh,
      qty,
      note: recvNote || null,
    })
    if (res) {
      toast.success('Партия оприходована на склад — остаток пополнен')
      load()
    }
  }

  // ---- Списание (брак / срок, проводка WRITEOFF) ----
  const writeOff = async (): Promise<void> => {
    if (!offWh || !offItem) {
      toast.error('Выберите склад и позицию для списания')
      return
    }
    const qty = Number(offQty)
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error('Количество списания должно быть больше нуля')
      return
    }
    const res = await post<OkRes>('writeoff', {
      action: 'WRITE_OFF',
      itemId: offItem,
      warehouseId: offWh,
      qty,
      note: offNote || null,
    })
    if (res) {
      toast.success('Списание оформлено (брак/срок) — проводка WRITEOFF')
      load()
    }
  }

  // ---- Создание перемещения (черновик) ----
  const createTransfer = async (): Promise<void> => {
    if (!trFrom || !trTo) {
      toast.error('Выберите склады отправителя и получателя')
      return
    }
    if (trFrom === trTo) {
      toast.error('Отправитель и получатель — один и тот же склад')
      return
    }
    const parsed = trLines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty) }))
    if (parsed.some((p) => p.itemId && !(Number.isFinite(p.qty) && p.qty > 0))) {
      toast.error('Проверьте количество в строках перемещения')
      return
    }
    const lines = parsed.filter((p) => p.itemId && p.qty > 0)
    if (lines.length === 0) {
      toast.error('Добавьте хотя бы одну позицию с количеством')
      return
    }
    const res = await post<NumberedRes>('transfer-create', {
      action: 'TRANSFER_CREATE',
      fromWarehouseId: trFrom,
      toWarehouseId: trTo,
      comment: trComment || null,
      lines,
    })
    if (res) {
      toast.success(`Перемещение ${res.number} создано (черновик)`)
      setTrComment('')
      setTrLines([{ itemId: '', qty: '10' }])
      load()
    }
  }

  // ---- Действия по документу перемещения ----
  const transferAction = async (t: TransferDocDTO, action: TransferAction, okMsg: string): Promise<void> => {
    const res = await post<OkRes>(`tr-${action}:${t.id}`, { action, transferId: t.id })
    if (res) {
      toast.success(okMsg)
      load()
    }
  }

  // ---- Создание акта инвентаризации (снимок учётных остатков) ----
  const createInventory = async (): Promise<void> => {
    if (!invWh) {
      toast.error('Выберите склад для инвентаризации')
      return
    }
    const res = await post<NumberedRes>('inv-create', {
      action: 'INVENTORY_CREATE',
      warehouseId: invWh,
      comment: invComment || null,
    })
    if (res) {
      toast.success(`Акт ${res.number} создан — снимок учётных остатков зафиксирован`)
      setInvComment('')
      load()
    }
  }

  // ---- Сохранение факта: собираются все непустые вводы ----
  const saveFacts = async (act: InventoryActDTO): Promise<void> => {
    const facts = act.lines
      .map((l) => ({ lineId: l.id, raw: (factInputs[l.id] ?? '').trim() }))
      .filter((f) => f.raw !== '')
      .map((f) => ({ lineId: f.lineId, factQty: Number(f.raw) }))
    if (facts.length === 0) {
      toast.error('Введите хотя бы одно фактическое количество')
      return
    }
    const res = await post<InvSaveRes>(`inv-save:${act.id}`, {
      action: 'INVENTORY_SAVE_FACT',
      actId: act.id,
      facts,
    })
    if (res) {
      toast.success(`Факт сохранён (${res.saved} поз.) — расхождения пересчитаны`)
      load()
    }
  }

  // ---- Проведение инвентаризации: расхождения закрываются проводками ----
  const completeAct = async (act: InventoryActDTO): Promise<void> => {
    const res = await post<InvCompleteRes>(`inv-complete:${act.id}`, {
      action: 'INVENTORY_COMPLETE',
      actId: act.id,
    })
    setConfirmAct(null)
    if (res) {
      toast.success(
        `Инвентаризация ${act.number} проведена: излишки ${fmtMoney(res.surplusCost)}, недостачи ${fmtMoney(
          res.shortageCost
        )} · корректировок: ${res.adjustedLines}`
      )
      load()
    }
  }

  // Расхождение строки: факт ещё не введен → null
  const lineDiff = (l: InventoryActDTO['lines'][number]): number | null => {
    const raw = (factInputs[l.id] ?? '').trim()
    if (raw === '') return null
    const fact = Number(raw)
    return Number.isFinite(fact) ? fact - l.accountedQty : null
  }

  // «Провести» доступна, когда факт сохранён для всех строк (нет несохранённых правок)
  const actDirty = (act: InventoryActDTO): boolean =>
    act.lines.some((l) => {
      const local = (factInputs[l.id] ?? '').trim()
      const saved = l.factQty == null ? '' : String(l.factQty)
      return local !== saved
    })

  const actAllCounted = (act: InventoryActDTO): boolean => act.lines.every((l) => l.factQty != null)

  const toggleTr = (id: string): void => {
    setOpenTr((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-slate-500">Загрузка склада…</CardContent>
      </Card>
    )
  }

  const spin = (key: string, cls?: string) =>
    busy === key ? <Loader2 className={`h-3.5 w-3.5 animate-spin ${cls ?? ''}`} /> : null

  return (
    <div className="space-y-4">
      {/* ---- Шапка (ФТ-008): сводка складского контура ---- */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="h-5 w-5 text-emerald-600" />
              Складской контур (ФТ-008)
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={load}
              title="Обновить"
              aria-label="Обновить данные склада"
              disabled={busy !== null}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Badge className="bg-slate-100 text-slate-600">
              <Warehouse className="h-3 w-3 mr-1" /> складов: {data.stats.warehouses}
            </Badge>
            <Badge className="bg-slate-100 text-slate-600">
              <Package className="h-3 w-3 mr-1" /> позиций: {data.stats.items}
            </Badge>
            <Badge className={data.stats.belowMin > 0 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-700'}>
              ниже минимума: {data.stats.belowMin}
            </Badge>
            <Badge className="bg-teal-100 text-teal-700">
              <Wallet className="h-3 w-3 mr-1" /> стоимость запаса: {fmtMoney(data.stats.totalValue)}
            </Badge>
            <Badge className="bg-slate-100 text-slate-500">
              <TrendingDown className="h-3 w-3 mr-1" /> списано сегодня: {fmtMoney(data.stats.consumedToday)}
            </Badge>
            <Badge className={data.stats.transfersInTransit > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'}>
              <Truck className="h-3 w-3 mr-1" /> в пути: {data.stats.transfersInTransit} перемещ.
            </Badge>
            <Badge className={data.stats.inventoryOpen > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'}>
              <ClipboardList className="h-3 w-3 mr-1" /> открытых инвентаризаций: {data.stats.inventoryOpen}
            </Badge>
            <Badge className="bg-emerald-100 text-emerald-700">излишки: {fmtMoney(data.stats.inventorySurplus)}</Badge>
            <Badge className="bg-rose-100 text-rose-700">недостачи: {fmtMoney(data.stats.inventoryShortage)}</Badge>
          </div>
          <p className="text-xs text-slate-500 pt-1">
            Мульти-склад: перемещения между складами и инвентаризация — полноценные документы с проводками; автосписание
            на визит — с основного склада; минимальные остатки — в Центр уведомлений (ФТ-013).
          </p>
        </CardHeader>
        {!canManage && (
          <CardContent className="pt-0">
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
              Ваша роль видит склад в режиме чтения (stock.read): приход, списание, перемещения и инвентаризация —
              у ролей с правом stock.manage.
            </div>
          </CardContent>
        )}
      </Card>

      <Tabs defaultValue="balances" className="space-y-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="balances">
            <Package className="h-3.5 w-3.5" /> Остатки
          </TabsTrigger>
          <TabsTrigger value="transfers">
            <Truck className="h-3.5 w-3.5" /> Перемещения
          </TabsTrigger>
          <TabsTrigger value="inventory">
            <ClipboardList className="h-3.5 w-3.5" /> Инвентаризация
          </TabsTrigger>
          <TabsTrigger value="movements">
            <ArrowRightLeft className="h-3.5 w-3.5" /> Движения
          </TabsTrigger>
        </TabsList>

        {/* ---- Вкладка «Остатки» (ФТ-008): матрица позиция × склад ---- */}
        <TabsContent value="balances">
          <div className={`grid grid-cols-1 gap-4 ${canManage ? 'lg:grid-cols-3' : ''}`}>
            <Card className={canManage ? 'lg:col-span-2' : ''}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Package className="h-4 w-4 text-slate-500" />
                  Матрица остатков по складам
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="rounded-lg border max-h-[520px] overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-48">Позиция</TableHead>
                        {data.warehouses.map((w) => (
                          <TableHead key={w.id} className="text-center whitespace-nowrap">
                            {w.name}
                          </TableHead>
                        ))}
                        <TableHead className="text-center">Итого</TableHead>
                        <TableHead className="text-center">Мин.</TableHead>
                        <TableHead className="text-right">Стоимость</TableHead>
                        <TableHead>Статус</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.items.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={data.warehouses.length + 5} className="text-center text-sm text-slate-500 py-6">
                            Позиций пока нет
                          </TableCell>
                        </TableRow>
                      )}
                      {data.items.map((i) => (
                        <TableRow key={i.id}>
                          <TableCell>
                            <div className="text-sm font-medium">{i.name}</div>
                            <div className="text-[10px] text-slate-400 font-mono">
                              {i.sku} · {i.category}
                            </div>
                          </TableCell>
                          {data.warehouses.map((w) => {
                            const qty = i.balances.find((b) => b.warehouseId === w.id)?.qty ?? 0
                            return (
                              <TableCell key={w.id} className={`text-center font-mono text-sm ${qty === 0 ? 'text-slate-300' : ''}`}>
                                {qty} <span className="text-[10px] text-slate-400">{i.unit}</span>
                              </TableCell>
                            )
                          })}
                          <TableCell className="text-center font-mono text-sm font-semibold">{i.total}</TableCell>
                          <TableCell className="text-center font-mono text-xs text-slate-500">{i.minQty}</TableCell>
                          <TableCell className="text-xs whitespace-nowrap">{fmtMoney(i.value)}</TableCell>
                          <TableCell>
                            {i.belowMin ? (
                              <Badge className="text-[10px] bg-amber-100 text-amber-800">ниже минимума</Badge>
                            ) : (
                              <Badge className="text-[10px] bg-emerald-100 text-emerald-700">норма</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {canManage && (
              <div className="space-y-4">
                {/* Приход (приёмка партии) */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Plus className="h-4 w-4 text-emerald-600" /> Приход (приёмка партии)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <Select value={recvWh} onValueChange={setRecvWh}>
                      <SelectTrigger className="h-9 text-sm" aria-label="Склад оприходования">
                        <SelectValue placeholder="Склад" />
                      </SelectTrigger>
                      <SelectContent>
                        {data.warehouses.map((w) => (
                          <SelectItem key={w.id} value={w.id}>
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={recvItem} onValueChange={setRecvItem}>
                      <SelectTrigger className="h-9 text-sm" aria-label="Позиция прихода">
                        <SelectValue placeholder="Выберите позицию" />
                      </SelectTrigger>
                      <SelectContent>
                        {data.items.map((i) => (
                          <SelectItem key={i.id} value={i.id}>
                            {i.name} ({i.total} {i.unit})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min={1}
                      value={recvQty}
                      onChange={(e) => setRecvQty(e.target.value)}
                      className="h-9 text-sm"
                      aria-label="Количество прихода"
                    />
                    <Input
                      value={recvNote}
                      onChange={(e) => setRecvNote(e.target.value)}
                      className="h-9 text-sm"
                      aria-label="Основание прихода"
                      placeholder="Основание (накладная №…)"
                    />
                    <Button
                      size="sm"
                      className="w-full bg-emerald-600 hover:bg-emerald-700"
                      onClick={receive}
                      disabled={busy !== null || !recvWh || !recvItem}
                    >
                      {spin('receive')}
                      <Plus className="h-3.5 w-3.5" /> Оприходовать
                    </Button>
                  </CardContent>
                </Card>

                {/* Списание (брак / срок) */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Trash2 className="h-4 w-4 text-rose-500" /> Списание (брак / срок)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <Select value={offWh} onValueChange={setOffWh}>
                      <SelectTrigger className="h-9 text-sm" aria-label="Склад списания">
                        <SelectValue placeholder="Склад" />
                      </SelectTrigger>
                      <SelectContent>
                        {data.warehouses.map((w) => (
                          <SelectItem key={w.id} value={w.id}>
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={offItem} onValueChange={setOffItem}>
                      <SelectTrigger className="h-9 text-sm" aria-label="Позиция списания">
                        <SelectValue placeholder="Выберите позицию" />
                      </SelectTrigger>
                      <SelectContent>
                        {data.items.map((i) => (
                          <SelectItem key={i.id} value={i.id}>
                            {i.name} ({i.total} {i.unit})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min={1}
                      value={offQty}
                      onChange={(e) => setOffQty(e.target.value)}
                      className="h-9 text-sm"
                      aria-label="Количество списания"
                    />
                    <Input
                      value={offNote}
                      onChange={(e) => setOffNote(e.target.value)}
                      className="h-9 text-sm"
                      aria-label="Причина списания"
                      placeholder="Причина (брак / истёк срок)"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full text-rose-600 border-rose-200 hover:bg-rose-50"
                      onClick={writeOff}
                      disabled={busy !== null || !offWh || !offItem}
                    >
                      {spin('writeoff')}
                      <Trash2 className="h-3.5 w-3.5" /> Списать
                    </Button>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ---- Вкладка «Перемещения» (ФТ-008): документы межскладских перемещений ---- */}
        <TabsContent value="transfers" className="space-y-4">
          {canManage && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Truck className="h-4 w-4 text-emerald-600" /> Новое перемещение
                </CardTitle>
                <p className="text-xs text-slate-500">Черновик → «Отправить» (в пути) → «Принять на склад» — с проводками</p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Select value={trFrom} onValueChange={setTrFrom}>
                    <SelectTrigger className="h-9 text-sm" aria-label="Склад-отправитель">
                      <SelectValue placeholder="Склад-отправитель" />
                    </SelectTrigger>
                    <SelectContent>
                      {data.warehouses.map((w) => (
                        <SelectItem key={w.id} value={w.id}>
                          {w.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={trTo} onValueChange={setTrTo}>
                    <SelectTrigger className="h-9 text-sm" aria-label="Склад-получатель">
                      <SelectValue placeholder="Склад-получатель" />
                    </SelectTrigger>
                    <SelectContent>
                      {data.warehouses.map((w) => (
                        <SelectItem key={w.id} value={w.id} disabled={w.id === trFrom}>
                          {w.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  value={trComment}
                  onChange={(e) => setTrComment(e.target.value)}
                  className="h-9 text-sm"
                  aria-label="Комментарий к перемещению"
                  placeholder="Комментарий (необязательно)"
                />
                <div className="space-y-2">
                  {trLines.map((line, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Select
                        value={line.itemId}
                        onValueChange={(v) =>
                          setTrLines(trLines.map((l, j) => (j === idx ? { ...l, itemId: v } : l)))
                        }
                      >
                        <SelectTrigger className="h-9 text-sm flex-1" aria-label={`Позиция строки ${idx + 1}`}>
                          <SelectValue placeholder="Позиция" />
                        </SelectTrigger>
                        <SelectContent>
                          {data.items.map((i) => (
                            <SelectItem key={i.id} value={i.id}>
                              {i.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        min={1}
                        value={line.qty}
                        onChange={(e) =>
                          setTrLines(trLines.map((l, j) => (j === idx ? { ...l, qty: e.target.value } : l)))
                        }
                        className="h-9 w-24 text-sm"
                        aria-label={`Количество позиции ${idx + 1}`}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0"
                        onClick={() => setTrLines(trLines.filter((_, j) => j !== idx))}
                        disabled={trLines.length <= 1}
                        aria-label={`Удалить строку ${idx + 1}`}
                        title="Удалить строку"
                      >
                        <X className="h-4 w-4 text-slate-400" />
                      </Button>
                    </div>
                  ))}
                  {trLines.some((l) => l.itemId) && (
                    <div className="text-[11px] text-slate-500 space-y-0.5 pt-1">
                      {trLines
                        .filter((l) => l.itemId)
                        .map((l, i) => {
                          const item = data.items.find((it) => it.id === l.itemId)
                          const bal = item?.balances.find((b) => b.warehouseId === trFrom)?.qty ?? 0
                          return (
                            <div key={`${l.itemId}-${i}`}>
                              {item?.name}: остаток на складе-отправителе: {bal} {item?.unit ?? ''}
                            </div>
                          )
                        })}
                    </div>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTrLines([...trLines, { itemId: '', qty: '10' }])}
                    disabled={busy !== null}
                  >
                    <Plus className="h-3.5 w-3.5" /> позиция
                  </Button>
                </div>
                <Button
                  className="bg-emerald-600 hover:bg-emerald-700"
                  onClick={createTransfer}
                  disabled={busy !== null || !trFrom || !trTo || trFrom === trTo}
                >
                  {spin('transfer-create')}
                  Создать перемещение (черновик)
                </Button>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Документы перемещений</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
                {data.transfers.length === 0 && (
                  <div className="text-center text-sm text-slate-500 py-6">Перемещений пока нет</div>
                )}
                {data.transfers.map((t) => (
                  <div key={t.id} className={`rounded-lg border p-3 ${t.status === 'CANCELED' ? 'opacity-60' : ''}`}>
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs text-slate-500">{t.number}</span>
                          <Badge className={`text-[10px] ${transferStatusClass(t.status)}`}>
                            {TRANSFER_STATUS_LABELS[t.status] ?? t.status}
                          </Badge>
                        </div>
                        <div className="text-sm font-medium flex items-center gap-1 flex-wrap pt-1">
                          <Warehouse className="h-3.5 w-3.5 text-slate-400" />
                          {t.fromWarehouseName}
                          <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
                          <Warehouse className="h-3.5 w-3.5 text-slate-400" />
                          {t.toWarehouseName}
                        </div>
                        <div className="text-xs text-slate-500 pt-0.5 truncate" title={linesSummary(t)}>
                          {linesSummary(t)} · {fmtWhen(t.createdAt)}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1 justify-end">
                        {canManage && t.status === 'DRAFT' && (
                          <>
                            <Button
                              size="sm"
                              className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700"
                              onClick={() =>
                                transferAction(
                                  t,
                                  'TRANSFER_DISPATCH',
                                  `Перемещение ${t.number} отправлено — статус «в пути»`
                                )
                              }
                              disabled={busy !== null}
                            >
                              {spin(`tr-TRANSFER_DISPATCH:${t.id}`)}
                              <Check className="h-3 w-3 mr-1" /> Отправить
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs text-slate-500"
                              onClick={() => transferAction(t, 'TRANSFER_CANCEL', `Перемещение ${t.number} отменено`)}
                              disabled={busy !== null}
                            >
                              Отменить
                            </Button>
                          </>
                        )}
                        {canManage && t.status === 'IN_TRANSIT' && (
                          <>
                            <Button
                              size="sm"
                              className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700"
                              onClick={() =>
                                transferAction(
                                  t,
                                  'TRANSFER_RECEIVE',
                                  `Перемещение ${t.number} принято на склад «${t.toWarehouseName}»`
                                )
                              }
                              disabled={busy !== null}
                            >
                              {spin(`tr-TRANSFER_RECEIVE:${t.id}`)}
                              <Check className="h-3 w-3 mr-1" /> Принять на склад
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs border-rose-200 text-rose-600 hover:bg-rose-50"
                              onClick={() =>
                                transferAction(
                                  t,
                                  'TRANSFER_CANCEL',
                                  `Перемещение ${t.number} возвращено отправителю на склад «${t.fromWarehouseName}»`
                                )
                              }
                              disabled={busy !== null}
                            >
                              <ArrowRight className="h-3 w-3 mr-1 rotate-180" /> Вернуть отправителю
                            </Button>
                          </>
                        )}
                        {t.status === 'COMPLETED' && t.completedAt && (
                          <span className="text-xs text-slate-500 self-center">принято: {fmtWhen(t.completedAt)}</span>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs text-slate-500"
                          onClick={() => toggleTr(t.id)}
                          aria-label={`Детали перемещения ${t.number}`}
                        >
                          {openTr[t.id] ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          детали
                        </Button>
                      </div>
                    </div>
                    {openTr[t.id] && (
                      <div className="mt-2 rounded-lg bg-slate-50 p-2 space-y-1">
                        {t.lines.map((l) => (
                          <div key={l.id} className="flex justify-between gap-2 text-xs">
                            <span className="truncate">
                              {l.name} <span className="text-slate-400 font-mono text-[10px]">{l.sku}</span>
                            </span>
                            <span className="font-mono whitespace-nowrap">
                              {l.qty} {l.unit}
                            </span>
                          </div>
                        ))}
                        {t.comment && <div className="text-xs text-slate-500 italic pt-1">{t.comment}</div>}
                        <div className="text-[10px] text-slate-400 pt-1">
                          создал: {t.createdBy ?? '—'}
                          {t.dispatchedAt && ` · отправлено: ${fmtWhen(t.dispatchedAt)}`}
                          {t.completedAt && ` · принято: ${fmtWhen(t.completedAt)}`}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Вкладка «Инвентаризация» (ФТ-008): акты с подсчётом факта ---- */}
        <TabsContent value="inventory" className="space-y-4">
          {canManage && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <ClipboardList className="h-4 w-4 text-emerald-600" /> Новый акт инвентаризации
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Select value={invWh} onValueChange={setInvWh}>
                    <SelectTrigger className="h-9 text-sm" aria-label="Склад инвентаризации">
                      <SelectValue placeholder="Склад" />
                    </SelectTrigger>
                    <SelectContent>
                      {data.warehouses.map((w) => (
                        <SelectItem key={w.id} value={w.id}>
                          {w.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={invComment}
                    onChange={(e) => setInvComment(e.target.value)}
                    className="h-9 text-sm"
                    aria-label="Комментарий к акту"
                    placeholder="Комментарий (необязательно)"
                  />
                </div>
                <Button
                  className="bg-emerald-600 hover:bg-emerald-700"
                  onClick={createInventory}
                  disabled={busy !== null || !invWh}
                >
                  {spin('inv-create')}
                  Создать акт инвентаризации
                </Button>
                <p className="text-xs text-slate-400">
                  Акт создаёт снимок учётных остатков на момент начала — фактические количества вводятся при подсчёте.
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Акты инвентаризации</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {data.inventories.length === 0 && (
                  <div className="text-center text-sm text-slate-500 py-6">Актов инвентаризации пока нет</div>
                )}
                {data.inventories.map((a) => {
                  const counted = a.lines.filter((l) => l.factQty != null).length
                  const dirty = actDirty(a)
                  const allCounted = actAllCounted(a)
                  return (
                    <div
                      key={a.id}
                      className={`rounded-lg border p-3 ${
                        a.status === 'OPEN' ? 'border-amber-200 bg-amber-50/40' : 'opacity-80'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-xs text-slate-500">{a.number}</span>
                            <Badge
                              className={`text-[10px] ${
                                a.status === 'OPEN' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-700'
                              }`}
                            >
                              {INVENTORY_STATUS_LABELS[a.status] ?? a.status}
                            </Badge>
                          </div>
                          <div className="text-sm font-medium flex items-center gap-1.5 pt-1">
                            <Warehouse className="h-3.5 w-3.5 text-slate-400" />
                            {a.warehouseName}
                          </div>
                          <div className="text-xs text-slate-500 pt-0.5">
                            {fmtWhen(a.createdAt)} · создал: {a.createdBy ?? '—'} · позиций: {a.lines.length}
                            {a.status === 'OPEN' && ` · посчитано: ${counted} из ${a.lines.length}`}
                            {a.status === 'COMPLETED' && a.completedAt && ` · проведено: ${fmtWhen(a.completedAt)}`}
                          </div>
                          {a.comment && <div className="text-xs text-slate-400 italic pt-0.5">{a.comment}</div>}
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <Badge className="text-[10px] bg-emerald-100 text-emerald-700">
                            излишки: {fmtMoney(a.surplusCost)}
                          </Badge>
                          <Badge className="text-[10px] bg-rose-100 text-rose-700">
                            недостачи: {fmtMoney(a.shortageCost)}
                          </Badge>
                        </div>
                      </div>

                      {/* Редактор факта для открытого акта */}
                      {a.status === 'OPEN' && canManage && (
                        <div className="mt-2 space-y-2">
                          <div className="rounded-lg border overflow-x-auto">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead className="min-w-44">Позиция</TableHead>
                                  <TableHead className="text-center w-24">Учёт</TableHead>
                                  <TableHead className="text-center w-28">Факт</TableHead>
                                  <TableHead className="text-center w-32">Расхождение</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {a.lines.map((l) => {
                                  const diff = lineDiff(l)
                                  return (
                                    <TableRow key={l.id}>
                                      <TableCell>
                                        <div className="text-sm">{l.name}</div>
                                        <div className="text-[10px] text-slate-400 font-mono">{l.sku}</div>
                                      </TableCell>
                                      <TableCell className="text-center font-mono text-sm">
                                        {l.accountedQty} <span className="text-[10px] text-slate-400">{l.unit}</span>
                                      </TableCell>
                                      <TableCell className="text-center">
                                        <Input
                                          type="number"
                                          min={0}
                                          value={factInputs[l.id] ?? ''}
                                          onChange={(e) =>
                                            setFactInputs({ ...factInputs, [l.id]: e.target.value })
                                          }
                                          placeholder="не посчитано"
                                          className="h-8 w-24 text-sm"
                                          aria-label={`Факт: ${l.name}`}
                                        />
                                      </TableCell>
                                      <TableCell className="text-center">
                                        {diff == null ? (
                                          <span className="text-xs text-slate-300">—</span>
                                        ) : diff > 0 ? (
                                          <Badge className="text-[10px] bg-emerald-100 text-emerald-700">
                                            +{diff} излишек
                                          </Badge>
                                        ) : diff < 0 ? (
                                          <Badge className="text-[10px] bg-rose-100 text-rose-700">
                                            −{Math.abs(diff)} недостача
                                          </Badge>
                                        ) : (
                                          <Badge className="text-[10px] bg-slate-100 text-slate-600">0</Badge>
                                        )}
                                      </TableCell>
                                    </TableRow>
                                  )
                                })}
                              </TableBody>
                            </Table>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                              onClick={() => saveFacts(a)}
                              disabled={busy !== null}
                            >
                              {spin(`inv-save:${a.id}`)}
                              Сохранить факт
                            </Button>
                            <Button
                              size="sm"
                              className="bg-emerald-600 hover:bg-emerald-700"
                              onClick={() => setConfirmAct(a)}
                              disabled={busy !== null || !allCounted || dirty}
                              title={
                                !allCounted || dirty
                                  ? 'Сначала сохраните факт по всем строкам акта'
                                  : 'Провести инвентаризацию с проводками'
                              }
                            >
                              {spin(`inv-complete:${a.id}`)}
                              Провести инвентаризацию
                            </Button>
                            {(!allCounted || dirty) && (
                              <span className="text-[11px] text-slate-400">
                                «Провести» активна, когда факт сохранён для всех строк
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Вкладка «Движения» (ФТ-008): журнал проводок ТМЦ ---- */}
        <TabsContent value="movements">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Журнал движений ТМЦ (ОТЧ-24)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border max-h-[440px] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">Время</TableHead>
                      <TableHead>Позиция</TableHead>
                      <TableHead className="w-44">Тип</TableHead>
                      <TableHead className="w-36">Склад</TableHead>
                      <TableHead className="w-24">Кол-во</TableHead>
                      <TableHead className="w-28">Стоимость</TableHead>
                      <TableHead>Основание</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.movements.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-sm text-slate-500 py-6">
                          Движений пока нет
                        </TableCell>
                      </TableRow>
                    )}
                    {data.movements.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="text-xs font-mono text-slate-500 whitespace-nowrap">
                          {fmtWhen(m.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">{m.itemName}</div>
                          <div className="text-[10px] text-slate-400 font-mono">{m.itemSku}</div>
                        </TableCell>
                        <TableCell>
                          <Badge className={`text-[10px] ${movementClass(m.type)}`}>
                            {STOCK_MOVEMENT_LABELS[m.type] ?? m.type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-slate-600">{m.warehouseName ?? '—'}</TableCell>
                        <TableCell className="font-mono text-sm whitespace-nowrap">
                          {m.qty} <span className="text-[10px] text-slate-400">{m.itemUnit}</span>
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{fmtMoney(m.cost)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1 flex-wrap max-w-56">
                            <span className="text-xs text-slate-600 truncate" title={m.note ?? ''}>
                              {m.note ?? '—'}
                            </span>
                            {m.visitId && <Badge className="text-[10px] bg-teal-100 text-teal-700">визит</Badge>}
                            {m.transferId && (
                              <span className="font-mono text-[10px] text-slate-400">перемещение</span>
                            )}
                            {m.inventoryId && (
                              <span className="font-mono text-[10px] text-slate-400">инвентаризация</span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Подтверждение проведения инвентаризации (ФТ-008) */}
      <AlertDialog open={confirmAct !== null} onOpenChange={(o) => !o && setConfirmAct(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Провести инвентаризацию {confirmAct?.number}?</AlertDialogTitle>
            <AlertDialogDescription>
              Расхождения закроются проводками: излишки придут на склад (ADJ_IN), недостачи спишутся (ADJ_OUT). После
              проведения акт переводится в статус «Проведена» и станет доступен только для чтения.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmAct && completeAct(confirmAct)}>Провести</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
