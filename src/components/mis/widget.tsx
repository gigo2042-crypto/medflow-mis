// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { WidgetConfigDTO } from '@/lib/types'
import BookingFlow from '@/components/booking/booking-flow'
import { Smartphone, Globe, Code2 } from 'lucide-react'

function embedSnippet(origin: string): string {
  return `<!-- Сайт клиники: блок онлайн-записи -->
<div id="medflow-booking"></div>
<script src="${origin}/embed.js" data-target="medflow-booking" defer></script>
<!-- домен сайта добавьте в WIDGET_ALLOWED_ORIGINS на сервере МИС -->`
}

// Вкладка персонала: предпросмотр виджета (тот же флоу, что на /book) и инструкция по встраиванию
export default function WidgetTab() {
  const [config, setConfig] = useState<WidgetConfigDTO | null>(null)
  const [origin, setOrigin] = useState('')
  useEffect(() => setOrigin(window.location.origin), [])

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      <Card className="lg:col-span-2 h-fit">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Smartphone className="h-5 w-5 text-emerald-600" />
            Виджет глазами пациента
          </CardTitle>
          <p className="text-xs text-slate-500">Предпросмотр страницы /book — запись в нём настоящая</p>
        </CardHeader>
        <CardContent className="flex justify-center">
          <div className="w-full max-w-[340px] rounded-[2rem] border-8 border-slate-900 bg-slate-900 shadow-xl overflow-hidden">
            <div className="h-5 bg-slate-900 flex items-center justify-center">
              <div className="h-1.5 w-16 rounded-full bg-slate-700" />
            </div>
            <div className="min-h-[520px] bg-white">
              <BookingFlow variant="mockup" onConfig={setConfig} />
            </div>
          </div>
        </CardContent>
      </Card>

            {/* Описание интеграции */}
      <div className="lg:col-span-3 space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-5 w-5 text-emerald-600" />
              Embeddable JS-виджет на сайте клиники
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="rounded-lg border p-3 text-center">
                <div className="text-xl font-bold text-emerald-700">{config?.stats?.today ?? 0}</div>
                <div className="text-[11px] text-slate-500">записей из виджета сегодня</div>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <div className="text-xl font-bold text-emerald-700">{config?.stats?.week ?? 0}</div>
                <div className="text-[11px] text-slate-500">за 7 дней</div>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <div className="text-xl font-bold text-emerald-700">15 мин</div>
                <div className="text-[11px] text-slate-500">удержание слота на время ввода кода (КП-017)</div>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <div className="text-xl font-bold text-emerald-700">{config?.consent ? 'да' : 'нет'}</div>
                <div className="text-[11px] text-slate-500">текст согласия на ПДн утверждён</div>
              </div>
            </div>
            <div className="text-xs text-slate-500">
              Публичная страница записи: <a className="underline text-emerald-700" href="/book" target="_blank" rel="noreferrer">{origin}/book</a> — без
              входа в МИС. Встраивание во фрейм разрешено только доменам из <code className="bg-slate-100 rounded px-1">WIDGET_ALLOWED_ORIGINS</code>
              (CSP frame-ancestors). Записи появляются в регистратуре с источником «Виджет» и получают каскад напоминаний.
            </div>
            <div>
              <div className="text-sm font-medium mb-1.5 flex items-center gap-1.5">
                <Code2 className="h-4 w-4 text-slate-400" /> Установка на сайт
              </div>
              <pre className="rounded-lg bg-slate-900 text-slate-100 p-3 text-[11px] leading-relaxed overflow-x-auto">{embedSnippet(origin)}</pre>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Пройдите флоу слева и проверьте</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-slate-600 space-y-1.5">
            <div className="flex gap-2">
              <Badge className="bg-emerald-100 text-emerald-700 shrink-0">1</Badge>
              <span>Запись появится в «Регистратура → Сегодня в клинике» с бейджем «Виджет»; согласие на обработку ПДн сохраняется в карте пациента (версия текста, время, IP).</span>
            </div>
            <div className="flex gap-2">
              <Badge className="bg-emerald-100 text-emerald-700 shrink-0">2</Badge>
              <span>Каскад напоминаний 48/24/3 ч создаётся автоматически — откройте вкладку «Напоминания».</span>
            </div>
            <div className="flex gap-2">
              <Badge className="bg-emerald-100 text-emerald-700 shrink-0">3</Badge>
              <span>Если пациент отменяет запись (кнопкой в MAX или по ссылке из SMS), слот предлагается пациентам из листа ожидания (ТУ-004).</span>
            </div>
            <div className="flex gap-2">
              <Badge className="bg-amber-100 text-amber-700 shrink-0">!</Badge>
              <span>Онлайн-оплаты в виджете нет.</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
