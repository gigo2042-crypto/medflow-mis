// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

// Экран входа: пароль + второй фактор (TOTP; в демо — код на экране), корпоративный SSO (OIDC).
// Демо-учётки и пароль приходят с /api/demo/accounts — этот маршрут существует только в демо.

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { api } from '@/lib/api'
import { Me } from '@/lib/rbac'
import { PublicConfig } from '@/lib/public-config'
import { toast } from 'sonner'
import { HeartPulse, KeyRound, Loader2, LogIn, ShieldCheck, Fingerprint } from 'lucide-react'

interface Pending2fa {
  challengeId: string
  method: 'TOTP' | 'DEMO'
  demoCode?: string
}

interface DemoAccounts {
  password: string
  accounts: Array<{ login: string; label: string }>
  sso: Array<{ email: string; note: string }>
  ssoPassword: string
}

const AUTH_ERRORS: Record<string, string> = {
  sso_state: 'SSO: ответ провайдера не прошёл проверку (state). Повторите вход.',
  sso_denied: 'SSO: вход отменён на стороне провайдера.',
  sso_token: 'SSO: провайдер не выдал токен.',
  sso_no_role: 'SSO: вашей учётной записи не назначена роль в МИС (группа IdP).',
  sso_mfa_required: 'SSO: для вашей роли обязателен второй фактор на стороне провайдера.',
  sso_disabled: 'SSO: учётная запись отключена администратором.',
  sso_unavailable: 'SSO: провайдер недоступен.',
  sso_userinfo: 'SSO: профиль пользователя не прошёл проверку.',
  sso_error: 'SSO: ошибка входа.',
}

export default function LoginScreen({ onLogin, config }: { onLogin: (me: Me) => void; config: PublicConfig | null }) {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState<Pending2fa | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [demo, setDemo] = useState<DemoAccounts | null>(null)
  const isDemo = config?.mode === 'demo'

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const err = params.get('auth_error')
    if (err) {
      toast.error(AUTH_ERRORS[err] ?? 'Ошибка входа')
      window.history.replaceState({}, '', '/')
    }
  }, [])

  useEffect(() => {
    if (!isDemo) return
    api<DemoAccounts>('/api/demo/accounts')
      .then(setDemo)
      .catch(() => setDemo(null))
  }, [isDemo])

  const doLogin = async () => {
    if (!login || !password) {
      toast.error('Введите логин и пароль')
      return
    }
    setBusy(true)
    try {
      const data = await api<{ me?: Me; pending2fa?: boolean; challengeId?: string; method?: 'TOTP' | 'DEMO'; demoCode?: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ login, password }),
      })
      if (data.pending2fa && data.challengeId) {
        setPending({ challengeId: data.challengeId, method: data.method ?? 'TOTP', demoCode: data.demoCode })
        setCode('')
        return
      }
      if (data.me) {
        toast.success(`Вход выполнен: ${data.me.name}`)
        onLogin(data.me)
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const doVerify = async () => {
    if (!pending || !code) return
    setBusy(true)
    try {
      const data = await api<{ me: Me }>('/api/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ challengeId: pending.challengeId, code }),
      })
      toast.success(`Вход выполнен: ${data.me.name}`)
      onLogin(data.me)
    } catch (e) {
      const msg = (e as Error).message
      toast.error(msg)
      if (/войдите заново|истёк/.test(msg)) setPending(null)
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (pending) doVerify()
    else doLogin()
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <main className="flex-1 flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-md space-y-4">
          <div className="flex items-center justify-center gap-3">
            <div className="h-11 w-11 rounded-xl bg-emerald-600 text-white flex items-center justify-center">
              <HeartPulse className="h-6 w-6" />
            </div>
            <div>
              <div className="text-lg font-semibold leading-tight">MedFlow</div>
              <div className="text-xs text-slate-500">МИС для частных клиник{isDemo ? ' — демо-стенд' : ''}</div>
            </div>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <LogIn className="h-4 w-4 text-emerald-600" />
                {pending ? 'Двухфакторное подтверждение' : 'Вход в систему'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="space-y-3">
                {pending ? (
                  <>
                    <Alert className="border-emerald-200 bg-emerald-50">
                      <ShieldCheck className="h-4 w-4 text-emerald-700" />
                      <AlertTitle className="text-sm">Второй фактор</AlertTitle>
                      <AlertDescription className="text-sm text-slate-700">
                        {pending.method === 'TOTP'
                          ? 'Введите 6-значный код из приложения-аутентификатора.'
                          : 'Код действителен 5 минут, не более 5 попыток.'}
                        {pending.demoCode && (
                          <>
                            {' '}Демо-стенд: код —{' '}
                            <Badge className="bg-emerald-600 font-mono">{pending.demoCode}</Badge>
                          </>
                        )}
                      </AlertDescription>
                    </Alert>
                    <Input
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="Код из 6 цифр"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoFocus
                      className="font-mono tracking-widest"
                      aria-label="Код подтверждения"
                    />
                  </>
                ) : (
                  <>
                    <Input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="Логин" autoFocus autoComplete="username" aria-label="Логин" />
                    <Input
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Пароль"
                      type="password"
                      autoComplete="current-password"
                      aria-label="Пароль"
                    />
                  </>
                )}
                <Button type="submit" disabled={busy} className="w-full bg-emerald-600 hover:bg-emerald-700">
                  {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <KeyRound className="h-4 w-4 mr-1" />}
                  {pending ? 'Подтвердить код' : 'Войти'}
                </Button>
                {pending && (
                  <Button type="button" variant="ghost" className="w-full text-slate-500" onClick={() => setPending(null)}>
                    Назад
                  </Button>
                )}
                {!pending && config?.oidc && (
                  <>
                    <div className="flex items-center gap-2 pt-1">
                      <div className="h-px flex-1 bg-slate-200" />
                      <span className="text-[11px] uppercase tracking-wide text-slate-400">или</span>
                      <div className="h-px flex-1 bg-slate-200" />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        window.location.href = '/api/auth/oidc/login'
                      }}
                      className="w-full border-slate-300 text-slate-700 hover:border-emerald-300 hover:bg-emerald-50"
                    >
                      <Fingerprint className="h-4 w-4 mr-1 text-emerald-700" />
                      {config.oidc.label}
                    </Button>
                  </>
                )}
              </form>
            </CardContent>
          </Card>

          {isDemo && demo && (
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs text-slate-500">Демо-учётные записи (пароль у всех: {demo.password})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {demo.accounts.map((a) => (
                    <button
                      key={a.login}
                      onClick={() => {
                        setLogin(a.login)
                        setPassword(demo.password)
                        setPending(null)
                      }}
                      className="rounded-full border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-emerald-50 hover:border-emerald-300 transition-colors"
                      title={`${a.label} — заполнить`}
                    >
                      <span className="font-mono">{a.login}</span> · {a.label}
                    </button>
                  ))}
                </div>
                {demo.sso.length > 0 && (
                  <p className="text-[11px] text-slate-400">
                    Демо-SSO: {demo.sso.map((s) => `${s.email} (${s.note})`).join(', ')} — пароль {demo.ssoPassword}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </main>
      <footer className="mt-auto border-t bg-white">
        <div className="max-w-7xl mx-auto px-4 py-3 text-xs text-slate-500">MedFlow · RBAC + 2FA · аудит действий</div>
      </footer>
    </div>
  )
}
