// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextResponse } from 'next/server'
import { isDemo } from '@/lib/config'

/** Демо-маршруты в production отвечают 404, как будто их нет (в Docker-образе их нет физически). */
export function demoOnly(): NextResponse | null {
  return isDemo() ? null : new NextResponse('Not Found', { status: 404 })
}
