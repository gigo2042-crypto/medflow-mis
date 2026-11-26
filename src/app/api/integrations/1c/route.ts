// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { actorId, actorMeta, audit, isService, requirePerm, requireServiceOrPerm } from '@/lib/auth-server'
import { buildOneCExport, processOneCQueue, type OneCScope } from '@/lib/onec'
import { logEvent } from '@/lib/integrations'
import { ONEC_SCOPE_LABELS, OneCExportDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

// Выгрузки в 1С (ИНТ-006, складской контур): пакеты CommerceML-XML —
// номенклатура, остатки по складам, документы движений за период.
// Очередь с 3 попытками; тик раз в 15 минут — мини-сервисом scheduler
// или вручную (PROCESS). Каждый пакет пишется в общий журнал интеграций.

function dto(ex: { id: string; scope: string; periodFrom: Date; periodTo: Date; status: string; attempts: number; docsCount: number; size: number; createdAt: Date; sentAt: Date | null; confirmedAt: Date | null; error: string | null }): OneCExportDTO {
  return {
    id: ex.id,
    scope: ex.scope,
    scopeLabel: ONEC_SCOPE_LABELS[ex.scope] ?? ex.scope,
    periodFrom: ex.periodFrom.toISOString(),
    periodTo: ex.periodTo.toISOString(),
    status: ex.status,
    attempts: ex.attempts,
    docsCount: ex.docsCount,
    size: ex.size,
    createdAt: ex.createdAt.toISOString(),
    sentAt: ex.sentAt ? ex.sentAt.toISOString() : null,
    confirmedAt: ex.confirmedAt ? ex.confirmedAt.toISOString() : null,
    error: ex.error,
  }
}

export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'integrations.read')
  if (!g.ok) return g.res
  try {
    const exports = await db.oneCExport.findMany({ orderBy: { createdAt: 'desc' }, take: 40 })
    const stats = {
      total: exports.length,
      queued: exports.filter((e) => e.status === 'QUEUED').length,
      sent: exports.filter((e) => e.status === 'SENT').length,
      confirmed: exports.filter((e) => e.status === 'CONFIRMED').length,
      error: exports.filter((e) => e.status === 'ERROR').length,
      totalDocs: exports.reduce((s, e) => s + e.docsCount, 0),
      totalSize: exports.reduce((s, e) => s + e.size, 0),
    }
    return NextResponse.json({ exports: exports.map(dto), stats })
  } catch (e) {
    console.error('[integrations/1c GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить выгрузки 1С' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const action = body.action

    if (action === 'CREATE') {
      const g = await requirePerm(req, 'integrations.manage')
      if (!g.ok) return g.res
      const scope = (['NOMENCLATURE', 'BALANCES', 'DOCS'].includes(body.scope) ? body.scope : 'DOCS') as OneCScope
      const to = body.to ? new Date(Number(body.to)) : new Date()
      const from = body.from ? new Date(Number(body.from)) : new Date(to.getTime() - 7 * 86400_000)
      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        return NextResponse.json({ error: 'Некорректный период выгрузки' }, { status: 400 })
      }
      const data = await buildOneCExport(scope, from, to)
      const ex = await db.oneCExport.create({
        data: {
          scope,
          periodFrom: from,
          periodTo: to,
          status: 'QUEUED',
          docsCount: data.docsCount,
          size: data.size,
          xml: data.xml,
          comment: body.comment || null,
        },
      })
      await logEvent({
        system: 'ERP_1C',
        summary: `Сформирован пакет 1С: ${ONEC_SCOPE_LABELS[scope]} (${data.docsCount} д.) — в очередь`,
        payload: { exportId: ex.id, scope, docs: data.docsCount, size: data.size },
        status: 'QUEUED',
      })
      await audit('onec.export_created', g.user.id, { id: ex.id, scope, docsCount: data.docsCount })
      return NextResponse.json({ ok: true, export: dto(ex) })
    }

    if (action === 'PROCESS') {
      // Очередь можно прокрутить из интерфейса или служебным ключом
      const g = await requireServiceOrPerm(req, 'integrations.manage')
      if (!g.ok) return g.res
      const res = await processOneCQueue()
      if (res.confirmed > 0 || res.sent > 0) {
        await logEvent({
          system: 'ERP_1C',
          summary: `Обмен с 1С: отправлено ${res.sent}, подтверждено ${res.confirmed}, повтор ${res.retried}, ошибки ${res.failed}`,
          payload: { ...res },
          status: res.failed > 0 ? 'ERROR' : 'CONFIRMED',
        })
      }
      if (!isService(req)) {
        await audit('onec.queue_processed', actorId(g), { ...res })
      }
      return NextResponse.json({ ok: true, result: res })
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 })
  } catch (e) {
    if (e instanceof Error) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error('[integrations/1c POST]', e)
    return NextResponse.json({ error: 'Не удалось выполнить действие' }, { status: 500 })
  }
}
