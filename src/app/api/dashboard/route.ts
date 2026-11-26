// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { capacityOn } from '@/lib/appointment-rules'
import { exceptionsBetween } from '@/lib/schedule-days'
import { db } from '@/lib/db'
import { requirePerm } from '@/lib/auth-server'
import { clinicDayStart, dateKey, todayKey, ddmm, pad2, riskClass, riskHint, riskLabel, riskScore } from '@/lib/mis-utils'
import { DashboardDTO, RiskItem } from '@/lib/types'
import { HIDDEN, patientAccessFor } from '@/lib/pd-access'

export const dynamic = 'force-dynamic'

// Дашборд руководителя: KPI, динамика, загрузка врачей, риски неявки (точки улучшения №4 и №9)
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'dashboard.read')
  if (!g.ok) return g.res
  try {
    const now = new Date()
    const dateParam = dateKey(now)
    const dayStart = clinicDayStart(0)
    const dayEnd = clinicDayStart(1)

    const todayAppts = await db.appointment.findMany({
      where: { start: { gte: dayStart, lt: dayEnd } },
      include: { patient: true, doctor: true },
      orderBy: { start: 'asc' },
    })
    const byStatus: Record<string, number> = {}
    for (const a of todayAppts) byStatus[a.status] = (byStatus[a.status] || 0) + 1

    const todayVisits = await db.visit.findMany({ where: { createdAt: { gte: dayStart, lt: dayEnd } } })
    const revenueToday = todayVisits.reduce((s, v) => s + (v.price || 0), 0)
    const doneVisits = todayAppts.filter((a) => a.status === 'DONE').length

    const sinceStart = clinicDayStart(-13)
    const histAppts = await db.appointment.findMany({ where: { start: { gte: sinceStart } } })
    const histVisits = await db.visit.findMany({ where: { createdAt: { gte: sinceStart } } })

    const series: DashboardDTO['series'] = []
    for (let i = 13; i >= 0; i--) {
      const day = clinicDayStart(-i)
      const k0 = day.getTime()
      const k1 = clinicDayStart(-i + 1).getTime()
      const dayAppts = histAppts.filter((a) => {
        const t = a.start.getTime()
        return t >= k0 && t < k1
      })
      const dayRevenue = histVisits
        .filter((v) => {
          const t = v.createdAt.getTime()
          return t >= k0 && t < k1
        })
        .reduce((s, v) => s + (v.price || 0), 0)
      series.push({
        day: dateKey(day),
        label: `${ddmm(day)}`,
        count: dayAppts.filter((a) => a.status !== 'CANCELED').length,
        noShows: dayAppts.filter((a) => a.status === 'NO_SHOW').length,
        revenue: dayRevenue,
      })
    }

    const finished = histAppts.filter((a) => ['DONE', 'NO_SHOW'].includes(a.status)).length || 1
    const noShowRate14 = Math.round((histAppts.filter((a) => a.status === 'NO_SHOW').length / finished) * 100)

    const doctors = await db.doctor.findMany({ orderBy: { name: 'asc' } })
    const todayK = todayKey()
    const todayEx = await exceptionsBetween(todayK, todayK)
    const util = doctors.map((doc) => {
      const total = Math.max(1, capacityOn(doc, [todayK], todayEx))
      const booked = todayAppts.filter((a) => a.doctorId === doc.id && a.status !== 'CANCELED').length
      return { id: doc.id, name: doc.name, specialty: doc.specialty, booked, total, percent: Math.min(100, Math.round((booked / total) * 100)) }
    })

    // Риск неявки по приближающимся приёмам (точка улучшения №4)
    const noShowCounts = new Map<string, number>()
    histAppts
      .filter((a) => a.status === 'NO_SHOW')
      .forEach((a) => {
        noShowCounts.set(a.patientId, (noShowCounts.get(a.patientId) || 0) + 1)
      })
    const upcoming = todayAppts.filter((a) => ['BOOKED', 'CONFIRMED', 'ARRIVED'].includes(a.status) && a.start.getTime() > now.getTime())
    const risks: RiskItem[] = upcoming
      .map((a) => {
        const hoursUntil = (a.start.getTime() - now.getTime()) / 3600000
        const pastNoShows = noShowCounts.get(a.patientId) || 0
        const r = riskScore(pastNoShows, a.source, hoursUntil)
        return {
          appointmentId: a.id,
          patientName: patientAccessFor(g.user, a.doctorId) === 'none' ? HIDDEN : `${a.patient.lastName} ${a.patient.firstName}`,
          doctorName: a.doctor.name,
          start: a.start.toISOString(),
          source: a.source,
          risk: r,
          riskLabel: riskLabel(r),
          riskClass: riskClass(r),
          hint: riskHint(r),
        }
      })
      .sort((a, b) => b.risk - a.risk)
      .slice(0, 6)

    const dto: DashboardDTO = {
      date: dateParam,
      todayTotal: todayAppts.length,
      byStatus,
      doneVisits,
      revenueToday,
      noShowRate14,
      doctors: util,
      series,
      risks,
    }
    return NextResponse.json(dto)
  } catch (e) {
    console.error('[dashboard GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить дашборд' }, { status: 500 })
  }
}
