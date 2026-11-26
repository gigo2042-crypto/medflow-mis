// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api } from '@/lib/api'
import { Me, can } from '@/lib/rbac'
import { AuditDTO, ROLE_LABELS, SessionDTO } from '@/lib/types'
import { IDLE_RELEASE_SECONDS, ddmmyyyy, formatIdle, timeStr } from '@/lib/mis-utils'
import { toast } from 'sonner'
import { KeyRound, LogIn, RefreshCw, MousePointerClick, Unlock, ScrollText, ShieldAlert } from 'lucide-react'

interface StaffUserLite {
  id: string
  name: string
  role: string
}

// Панель concurrent-лицензирования с авто-освобождением простоя (точка улучшения №5)
export default function Sessions({ me }: { me: Me }) {
  const canManage = can(me, 'sessions.manage')
  const canAudit = can(me, 'audit.read')
  const canSessions = can(me, 'sessions.read') // панель лицензий; у руководителя только аудит
  const [sessions, setSessions] = useState<SessionDTO[]>([])
  const [licenseLimit, setLicenseLimit] = useState(3)
  const [users, setUsers] = useState<StaffUserLite[]>([])
  const [userId, setUserId] = useState('')
  const [device, setDevice] = useState('web')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [idleReleased, setIdleReleased] = useState(0)
  const [auditEntries, setAuditEntries] = useState<AuditDTO[]>([])

  const load = useCallback(async () => {
    if (!canSessions) return
    try {
      const data = await api<{ sessions: SessionDTO[]; licenseLimit: number; idleReleased: number }>('/api/sessions')
      setSessions(data.sessions)
      setLicenseLimit(data.licenseLimit)
      setIdleReleased(data.idleReleased)
    } catch (e) {
      console.error(e)
    }
  }, [canSessions])

  useEffect(() => {
    if (canManage) {
      api<{ users: StaffUserLite[] }>('/api/staff')
        .then((d) => {
          setUsers(d.users)
          if (d.users.length > 0) setUserId(d.users[0].id)
        })
        .catch((e) => toast.error((e as Error).message))
    }
    if (canAudit) {
      api<{ entries: AuditDTO[] }>('/api/audit?take=40')
        .then((d) => setAuditEntries(d.entries))
        .catch((e) => toast.error((e as Error).message))
    }
    load()
  }, [load, canManage, canAudit])

  useEffect(() => {
    const poll = setInterval(load, 3000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [load])

  const login = async () => {
    if (!userId) return
    setBusy(true)
    try {
      await api('/api/sessions', { method: 'POST', body: JSON.stringify({ userId, device }) })
      toast.success('Сессия открыта')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const touch = async (id: string) => {
    try {
      await api(`/api/sessions/${id}`, { method: 'PATCH' })
      toast.success('Активность обновлена')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const release = async (id: string, name: string) => {
    try {
      await api(`/api/sessions/${id}`, { method: 'DELETE' })
      toast.success(`Место освобождено: ${name}`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const AUDIT_ACTION_LABELS: Record<string, string> = {
    'auth.login': 'Вход в систему',
    'auth.login_2fa': 'Вход через 2FA',
    'auth.logout': 'Выход',
    'auth.login_failed': 'Неудачный вход',
    'auth.2fa_challenge': 'Выдан код 2FA',
    'appointment.created': 'Создана запись',
    'appointment.status_changed': 'Изменён статус записи',
    'visit.started': 'Начат приём',
    'visit.saved': 'Сохранён протокол',
    'visit.completed': 'Приём завершён',
    'patient.created': 'Создан пациент',
    'payment.created': 'Создана оплата',
    'payment.fiscalized': 'Выдан фискальный чек',
    'payment.refunded': 'Оформлен возврат',
    'document.signed': 'Подписан документ',
    'document.created': 'Сохранён документ',
    'price.created': 'Добавлена услуга',
    'price.updated': 'Изменён прайс-лист',
    'license.session_opened': 'Открыта лицензионная сессия',
    'license.session_released': 'Освобождено место',
    'ai.summary_requested': 'Запрошено AI-резюме',
    'waiting.entry_created': 'Пациент поставлен в лист ожидания',
    'waiting.slot_offered': 'Слот предложен из очереди',
    'waiting.booked': 'Запись из листа ожидания',
    'waiting.declined': 'Отказ от предложенного слота',
    'waiting.entry_removed': 'Заявка снята с очереди',
    'reminder.batch_sent': 'Воркер отправил каскад',
    'reminder.sent_now': 'Напоминание отправлено вручную',
    'reminder.responded': 'Ответ пациента на напоминание',
    'widget.booking_created': 'Онлайн-запись из виджета',
  }

  const percent = Math.min(100, Math.round((sessions.length / licenseLimit) * 100))

  return (
    <div className="space-y-4 max-w-5xl">
      {canSessions && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <CardTitle className="text-sm flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-emerald-600" /> Concurrent-лицензирование — панель клиники
              </CardTitle>
              <div className="flex items-center gap-2">
                {idleReleased > 0 && (
                  <Badge variant="outline" className="text-amber-700 border-amber-300">
                    авто-освобождено: {idleReleased}
                  </Badge>
                )}
                <Badge className={sessions.length >= licenseLimit ? 'bg-rose-600' : 'bg-emerald-600'}>
                  {sessions.length} / {licenseLimit} мест
                </Badge>
                <Button variant="ghost" size="icon" onClick={load} aria-label="Обновить">
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <Progress value={percent} className="h-2 mt-2" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert className="border-emerald-200 bg-emerald-50">
              <KeyRound className="h-4 w-4 text-emerald-700" />
              <AlertTitle className="text-sm">Честное лицензирование рабочих мест</AlertTitle>
              <AlertDescription className="text-sm text-slate-700">
                Лимит — {licenseLimit} одновременных рабочих мест. Сессии без активности {Math.round(IDLE_RELEASE_SECONDS / 60)} минут
                освобождаются автоматически; администратор видит простой каждой сессии и может освободить место вручную. Число
                заведённых сотрудников не ограничено.
              </AlertDescription>
            </Alert>
  
            {canManage && (
              <div className="rounded-lg border p-3 space-y-2 bg-slate-50">
                <div className="text-sm font-medium">Войти в систему (имитация рабочего места)</div>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px_auto] gap-2">
                  <Select value={userId} onValueChange={setUserId}>
                    <SelectTrigger aria-label="Сотрудник">
                      <SelectValue placeholder="Сотрудник" />
                    </SelectTrigger>
                    <SelectContent>
                      {users.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.name} — {ROLE_LABELS[u.role] || u.role}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={device} onValueChange={setDevice}>
                    <SelectTrigger aria-label="Устройство">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="web">Веб-браузер</SelectItem>
                      <SelectItem value="планшет · регистратура">Планшет регистратуры</SelectItem>
                      <SelectItem value="мобильное приложение">Мобильное приложение</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button onClick={login} disabled={busy || !userId} className="bg-emerald-600 hover:bg-emerald-700">
                    <LogIn className="h-4 w-4 mr-1" /> Открыть сессию
                  </Button>
                </div>
                <p className="text-xs text-slate-500">
                  Если все места заняты, сессия встаёт в очередь — администратор видит это в панели и освобождает место одним кликом.
                </p>
              </div>
            )}
            {!canManage && (
              <Alert className="border-amber-200 bg-amber-50">
                <ShieldAlert className="h-4 w-4 text-amber-600" />
                <AlertTitle className="text-sm">Просмотр без управления</AlertTitle>
                <AlertDescription className="text-xs text-slate-600">
                  Управление сессиями доступно администратору клиники (RBAC: sessions.manage). Ваша роль — наблюдение за использованием лицензий и журнал аудита.
                </AlertDescription>
              </Alert>
            )}
  
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Сотрудник</TableHead>
                  <TableHead>Роль</TableHead>
                  <TableHead>Устройство</TableHead>
                  <TableHead>Простой</TableHead>
                  <TableHead className="text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-sm text-slate-500">
                      Активных сессий нет — откройте сессию выше.
                    </TableCell>
                  </TableRow>
                )}
                {sessions.map((s) => {
                  const idle = Math.max(0, Math.floor((now - new Date(s.lastActivity).getTime()) / 1000))
                  const soonIdle = idle >= IDLE_RELEASE_SECONDS - 60
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.userName}</TableCell>
                      <TableCell className="text-slate-600">{ROLE_LABELS[s.role] || s.role}</TableCell>
                      <TableCell className="text-slate-600">{s.device}</TableCell>
                      <TableCell>
                        <span className={soonIdle ? 'text-amber-700 font-medium' : 'text-slate-600'}>{formatIdle(idle)}</span>
                        {soonIdle && <span className="ml-2 text-xs text-amber-700">скоро авто-освобождение</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        {canManage && (
                          <div className="flex justify-end gap-1.5">
                            <Button variant="outline" size="sm" className="h-8" onClick={() => touch(s.id)}>
                              <MousePointerClick className="h-3.5 w-3.5 mr-1" /> Активность
                            </Button>
                            <Button variant="outline" size="sm" className="h-8 text-rose-600 border-rose-200 hover:bg-rose-50" onClick={() => release(s.id, s.userName)}>
                              <Unlock className="h-3.5 w-3.5 mr-1" /> Освободить
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {canAudit && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <CardTitle className="text-sm flex items-center gap-2">
                <ScrollText className="h-4 w-4 text-emerald-600" /> Журнал аудита (append-only, ФТ-039 / ОТЧ-31)
              </CardTitle>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Обновить журнал"
                onClick={() =>
                  api<{ entries: AuditDTO[] }>('/api/audit?take=40')
                    .then((d) => setAuditEntries(d.entries))
                    .catch((e) => toast.error((e as Error).message))
                }
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">Время</TableHead>
                  <TableHead>Пользователь</TableHead>
                  <TableHead>Действие</TableHead>
                  <TableHead className="hidden md:table-cell">Детали</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditEntries.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-sm text-slate-500">
                      Записей аудита пока нет.
                    </TableCell>
                  </TableRow>
                )}
                {auditEntries.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-xs">{ddmmyyyy(new Date(a.createdAt))} {timeStr(new Date(a.createdAt))}</TableCell>
                    <TableCell className="text-sm">{a.userName || '—'}</TableCell>
                    <TableCell className="text-sm">{AUDIT_ACTION_LABELS[a.action] || a.action}</TableCell>
                    <TableCell className="hidden md:table-cell max-w-[320px]">
                      <span className="text-xs text-slate-500 truncate block">{a.meta || '—'}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-xs text-slate-400 mt-2">Журнал неизменяем: удаление записей не предусмотрено (АРХ-013). В продакшене — hash-chain целостности и хранение не менее 5 лет.</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
