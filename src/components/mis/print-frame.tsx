// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
'use client'

// Универсальная печать печатной формы (ФТ-009, ФТ-056): на экране — карточка A4,
// при печати виден только .print-area (стили в globals.css)

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Printer, X } from 'lucide-react'

interface Props {
  title: string
  children: React.ReactNode
  onClose: () => void
}

export default function PrintFrame({ title, children, onClose }: Props) {
  useEffect(() => {
    document.body.classList.add('printing')
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.classList.remove('printing')
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[100] bg-slate-900/60 overflow-auto p-4 sm:p-8" role="dialog" aria-modal="true" aria-label={`Печать: ${title}`}>
      <div className="max-w-[740px] mx-auto space-y-3">
        <div className="no-print flex items-center justify-between gap-2 bg-white rounded-lg px-3 py-2 shadow">
          <span className="text-sm font-medium text-slate-700 truncate">{title}</span>
          <div className="flex gap-2 shrink-0">
            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => window.print()}>
              <Printer className="h-4 w-4 mr-1" /> Печать / PDF
            </Button>
            <Button size="sm" variant="outline" onClick={onClose}>
              <X className="h-4 w-4 mr-1" /> Закрыть
            </Button>
          </div>
        </div>
        <div className="print-area bg-white text-slate-900 shadow-xl px-10 py-8 font-serif text-[13px] leading-relaxed whitespace-pre-wrap min-h-[600px]">
          {children}
        </div>
      </div>
    </div>
  )
}
