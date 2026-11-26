// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import type { Metadata } from 'next'
import BookingFlow from '@/components/booking/booking-flow'
import { Toaster } from '@/components/ui/sonner'
import { notFound } from 'next/navigation'
import { isProduction } from '@/lib/config'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Онлайн-запись', robots: { index: false } }

// Публичная страница онлайн-записи (ФТ-012). Открывается напрямую или во фрейме на сайте
// клиники через /embed.js; встраивание разрешено только доменам из WIDGET_ALLOWED_ORIGINS.
export default function BookPage() {
  if (isProduction() && process.env.WIDGET_ENABLED === '0') notFound()
  return (
    <main className="min-h-screen bg-slate-50 flex justify-center sm:py-6">
      <div className="w-full max-w-md sm:rounded-xl sm:border sm:shadow-sm overflow-hidden bg-white">
        <BookingFlow variant="page" />
      </div>
      <Toaster position="top-center" richColors />
    </main>
  )
}
