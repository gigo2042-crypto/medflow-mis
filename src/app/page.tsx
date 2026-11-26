// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useCallback, useEffect, useState } from 'react'
import Header from '@/components/mis/header'
import LoginScreen from '@/components/mis/login-screen'
import Registratura from '@/components/mis/registratura'
import ScheduleView from '@/components/mis/schedule'
import Emk from '@/components/mis/emk'
import Cash from '@/components/mis/cash'
import Documents from '@/components/mis/documents'
import DashboardView from '@/components/mis/dashboard'
import Sessions from '@/components/mis/sessions'
import WaitingList from '@/components/mis/waiting-list'
import Reminders from '@/components/mis/reminders'
import NotificationCenter from '@/components/mis/notification-center'
import Stock from '@/components/mis/stock'
import Integrations from '@/components/mis/integrations'
import Reports from '@/components/mis/reports'
import WidgetTab from '@/components/mis/widget'
import Campaigns from '@/components/mis/campaigns'
import DemoBanner from '@/components/mis/demo-banner'
import { setClinicTz } from '@/lib/mis-utils'
import { PublicConfig } from '@/lib/public-config'
import { Toaster } from '@/components/ui/sonner'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'
import { CalendarPlus, CalendarDays, Stethoscope, Wallet, FileText, BarChart3, KeyRound, Hourglass, BellRing, Smartphone, Inbox, Boxes, Plug, FileSpreadsheet, Megaphone } from 'lucide-react'
import { api } from '@/lib/api'
import { Me, TabId } from '@/lib/rbac'
import { toast } from 'sonner'

const TABS: Array<{ id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'reg', label: 'Регистратура', icon: CalendarPlus },
  { id: 'schedule', label: 'Расписание', icon: CalendarDays },
  { id: 'waiting', label: 'Лист ожидания', icon: Hourglass },
  { id: 'reminders', label: 'Напоминания', icon: BellRing },
  { id: 'notifications', label: 'Центр уведомлений', icon: Inbox },
  { id: 'emk', label: 'Приём (ЭМК)', icon: Stethoscope },
  { id: 'cash', label: 'Касса', icon: Wallet },
  { id: 'docs', label: 'Документы', icon: FileText },
  { id: 'stock', label: 'Склад', icon: Boxes },
  { id: 'integrations', label: 'Интеграции', icon: Plug },
  { id: 'reports', label: 'Отчёты', icon: FileSpreadsheet },
  { id: 'campaigns', label: 'Кампании', icon: Megaphone },
  { id: 'widget', label: 'Виджет записи', icon: Smartphone },
  { id: 'dashboard', label: 'Дашборд', icon: BarChart3 },
  { id: 'sessions', label: 'Сессии', icon: KeyRound },
]

export default function Home() {
  const [me, setMe] = useState<Me | null>(null)
  const [boot, setBoot] = useState(true)
  const [tab, setTab] = useState<TabId>('reg')
  const [focusAppointmentId, setFocusAppointmentId] = useState<string | null>(null)

  const [config, setConfig] = useState<PublicConfig | null>(null)

  // Конфигурация (режим, часовой пояс клиники, SSO) и восстановление сессии по httpOnly-cookie.
  // Возврат из SSO обрабатывает сервер (/api/auth/oidc/callback) — здесь только /api/auth/me.
  useEffect(() => {
    api<PublicConfig>('/api/config')
      .then((c) => {
        setClinicTz(c.clinicTz)
        setConfig(c)
      })
      .catch(() => setConfig(null))
      .then(() => api<{ me: Me }>('/api/auth/me'))
      .then((d) => {
        if (d.me.clinicTz) setClinicTz(d.me.clinicTz)
        setMe(d.me)
        setTab(d.me.tabs[0] || 'dashboard')
      })
      .catch(() => setMe(null))
      .finally(() => setBoot(false))
  }, [])

  const openVisit = useCallback(
    (appointmentId: string) => {
      if (!me) return
      if (!me.tabs.includes('emk')) {
        toast.error('Контур приёма недоступен вашей роли (RBAC)')
        return
      }
      setFocusAppointmentId(appointmentId)
      setTab('emk')
    },
    [me]
  )

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } catch {
      // сессия уже недействительна — ок
    }
    setMe(null)
    setTab('reg')
    setFocusAppointmentId(null)
  }, [])

  if (boot) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Загрузка МИС…
        </div>
      </div>
    )
  }

  if (!me) {
    return (
      <>
        {config?.mode === 'demo' && <DemoBanner me={null} />}
        <LoginScreen config={config} onLogin={(m) => { if (m.clinicTz) setClinicTz(m.clinicTz); setMe(m); setTab(m.tabs[0] || 'reg') }} />
        <Toaster position="top-right" richColors />
      </>
    )
  }

  const visibleTabs = TABS.filter((t) => me.tabs.includes(t.id))
  // Охрана клиента: содержимое вкладки рендерится только при наличии права (меню — тот же список с сервера);
  // недоступная вкладка заменяется первой разрешённой. Данные при этом всё равно защищены на сервере.
  const activeTab: TabId | null = me.tabs.includes(tab) ? tab : (me.tabs[0] ?? null)

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {me.mode === 'demo' && <DemoBanner me={me} />}
      <Header me={me} onLogout={logout} />
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 py-5">
        <nav className="flex flex-wrap gap-1.5 mb-5" aria-label="Разделы МИС">
          {visibleTabs.map((t) => {
            const Icon = t.icon
            const active = activeTab === t.id
            return (
              <Button
                key={t.id}
                variant={active ? 'default' : 'ghost'}
                onClick={() => setTab(t.id)}
                aria-current={active ? 'page' : undefined}
                className={active ? 'bg-emerald-600 hover:bg-emerald-700' : 'text-slate-600 hover:text-slate-900'}
              >
                <Icon className="h-4 w-4 mr-1" /> {t.label}
              </Button>
            )
          })}
        </nav>

        {activeTab === null && <div className="text-sm text-slate-500">Для вашей роли нет доступных разделов — обратитесь к администратору.</div>}
        {activeTab === 'reg' && <Registratura me={me} onOpenVisit={openVisit} />}
        {activeTab === 'schedule' && <ScheduleView me={me} onOpenVisit={openVisit} />}
        {activeTab === 'waiting' && <WaitingList me={me} />}
        {activeTab === 'reminders' && <Reminders me={me} />}
        {activeTab === 'notifications' && <NotificationCenter me={me} />}
        {activeTab === 'emk' && <Emk me={me} focusAppointmentId={focusAppointmentId} />}
        {activeTab === 'cash' && <Cash me={me} />}
        {activeTab === 'docs' && <Documents me={me} />}
        {activeTab === 'stock' && <Stock me={me} />}
        {activeTab === 'integrations' && <Integrations me={me} />}
        {activeTab === 'reports' && <Reports me={me} />}
        {activeTab === 'widget' && <WidgetTab />}
        {activeTab === 'dashboard' && <DashboardView />}
        {activeTab === 'sessions' && <Sessions me={me} />}
        {activeTab === 'campaigns' && <Campaigns />}
      </main>
      <footer className="mt-auto border-t bg-white">
        <div className="max-w-7xl mx-auto px-4 py-3 text-xs text-slate-500 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-medium text-slate-600">MedFlow</span>
          <span>{me.mode === 'demo' ? 'Демо-стенд: данные вымышленные, внешние отправки отключены' : 'МИС для частных клиник'}</span>
        </div>
      </footer>
      <Toaster position="top-right" richColors />
    </div>
  )
}
