// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

// Публичная страница ответа пациента по ссылке из SMS: подтвердить/отменить приём,
// принять приглашение из листа ожидания, отписаться от рекламы. Без входа в систему.
import { use, useEffect, useState } from 'react'

type Info = { title: string; details: string | null; actions: string[]; state: string }

const LABELS: Record<string, string> = {
  confirm: 'Подтверждаю',
  cancel: 'Отменить запись',
  book: 'Записаться',
  decline: 'Не подходит',
  unsubscribe: 'Отписаться от рекламы',
}

export default function PatientLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [info, setInfo] = useState<Info | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch(`/api/public/patient-link?t=${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok) setError(j.error || 'Ссылка недействительна')
        else setInfo(j)
      })
      .catch(() => setError('Нет связи с сервером'))
  }, [token])

  async function act(action: string) {
    if (action === 'cancel' && !window.confirm('Отменить запись?')) return
    setBusy(true)
    try {
      const r = await fetch('/api/public/patient-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: token, action }),
      })
      const j = await r.json().catch(() => ({}))
      setResult(j.message || j.error || 'Готово')
      if (r.ok) setInfo((i) => (i ? { ...i, actions: [] } : i))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm rounded-xl border bg-white p-6 shadow-sm space-y-4">
        {error && <p className="text-sm text-rose-700">{error}</p>}
        {!error && !info && <p className="text-sm text-slate-500">Загрузка…</p>}
        {info && (
          <>
            <h1 className="text-lg font-semibold">{info.title}</h1>
            {info.details && <p className="text-sm">{info.details}</p>}
            <p className="text-xs text-slate-500">{info.state}</p>
            {result && <p className="text-sm font-medium text-emerald-700">{result}</p>}
            <div className="flex flex-wrap gap-2">
              {info.actions.map((a) => (
                <button
                  key={a}
                  disabled={busy}
                  onClick={() => act(a)}
                  className={`rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${a === 'cancel' || a === 'decline' || a === 'unsubscribe' ? 'bg-rose-600' : 'bg-emerald-600'}`}
                >
                  {LABELS[a] || a}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  )
}
