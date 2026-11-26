// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { capacityOn } from '@/lib/appointment-rules'
import { dayKeysBetween, exceptionsBetween } from '@/lib/schedule-days'
import { db } from '@/lib/db'
import { requirePerm } from '@/lib/auth-server'
import { CATALOG } from '@/lib/reports-catalog'
import { canSeeSection, reportSectionsOf } from '@/lib/report-access'
import { clinicDayStart, dateKey, ddmm, ddmmHHMM, ddmmyyyy, pad2, zonedParts } from '@/lib/mis-utils'
import { ReportColumn, ReportDTO } from '@/lib/types'
import { canSeeMedical, canSeePd, HIDDEN } from '@/lib/pd-access'

export const dynamic = 'force-dynamic'


function iso(d: Date): string {
  return d.toISOString()
}

function money(n: number): string {
  return `${n.toLocaleString('ru-RU')} ₽`
}

// Отчётность ОТЧ-01…36: операционные отчёты считаются прямыми запросами
// к «PostgreSQL» (в демо — SQLite) на актуальных данных; аналитические
// витрины имитируются агрегатами на лету. Фильтры: период, врач, специальность.
export async function GET(req: NextRequest) {
  const g = await requirePerm(req, 'reports.read')
  if (!g.ok) return g.res
  try {
    const url = req.nextUrl.searchParams
    const allowed = reportSectionsOf(g.user.role)
    const section = url.get('section') || allowed[0] || 'operations'
    if (!canSeeSection(g.user.role, section)) {
      return NextResponse.json({ error: 'Раздел отчётности недоступен для вашей роли' }, { status: 403 })
    }
    const fromMs = Number(url.get('from')) || Date.now() - 30 * 86400_000
    const toMs = Number(url.get('to')) || Date.now()
    const from = new Date(fromMs)
    const to = new Date(toMs)

    // Загружаем только данные нужного раздела и (где возможно) только за период —
    // без выгрузки всех таблиц на каждый запрос. Агрегаты, которым нужна история
    // (первое обращение, отток, новые/повторные), берут узкие select-поля.
    const S = section
    const inRange = { gte: from, lte: to }
    const skip = <T,>(): Promise<T[]> => Promise.resolve([])
    const needAll = (list: string[]) => list.includes(S)
    const AUDIT_CAP = 20000
    const [appointments, visits, payments, stockItems, movements, doctors, patients, waiting, notifications, audit, sessions, claims, reminders] =
      await Promise.all([
        needAll(['operations', 'marketing', 'predictive'])
          ? db.appointment.findMany({
              // история источников нужна ОТЧ-06; прогноз — будущие 14 дней
              where: S === 'operations' ? { start: inRange } : S === 'predictive' ? { start: { gte: clinicDayStart(0), lt: clinicDayStart(14) } } : { start: { lte: to } },
              select: { id: true, start: true, status: true, source: true, doctorId: true, patientId: true, duration: true },
            })
          : skip<{ id: string; start: Date; status: string; source: string; doctorId: string; patientId: string; duration: number }>(),
        needAll(['operations', 'patients', 'finance', 'staff', 'predictive'])
          ? db.visit.findMany({
              where: S === 'patients' || S === 'predictive' ? { createdAt: { lte: to } } : { createdAt: inRange },
              select: {
                id: true, createdAt: true, patientId: true, doctorId: true, price: true, diagnosisCode: true, diagnosisName: true,
                patient: { select: { lastName: true, firstName: true } },
                doctor: { select: { name: true } },
              },
            })
          : skip<never>(),
        S === 'finance'
          ? db.payment.findMany({ where: { createdAt: inRange }, include: { patient: { select: { lastName: true, firstName: true, cardNumber: true } } } })
          : skip<never>(),
        S === 'stock' ? db.stockItem.findMany() : skip<never>(),
        S === 'stock' ? db.stockMovement.findMany({ where: { createdAt: inRange }, include: { item: true } }) : skip<never>(),
        db.doctor.findMany({ orderBy: { name: 'asc' } }),
        needAll(['patients', 'predictive'])
          ? db.patient.findMany({ where: { anonymizedAt: null }, select: { id: true, lastName: true, firstName: true, birthDate: true, gender: true } })
          : skip<never>(),
        S === 'operations' ? db.waitingListEntry.findMany({ where: { createdAt: inRange } }) : skip<never>(),
        S === 'marketing' ? db.notification.findMany({ where: { createdAt: inRange }, select: { kind: true, status: true, createdAt: true } }) : skip<never>(),
        S === 'compliance'
          ? db.auditLog.findMany({
              where: { createdAt: inRange },
              include: { user: { select: { id: true, name: true, role: true } } },
              orderBy: { createdAt: 'desc' },
              take: AUDIT_CAP,
            })
          : skip<never>(),
        S === 'compliance' ? db.workSession.findMany({ include: { user: { select: { name: true, role: true } } } }) : skip<never>(),
        S === 'finance' ? db.dmsClaim.findMany({ where: { createdAt: inRange } }) : skip<never>(),
        S === 'marketing' ? db.reminder.findMany({ where: { createdAt: inRange }, select: { response: true, createdAt: true } }) : skip<never>(),
      ])
    const medical = canSeeMedical(g.user)
    // ФИО и номера карт в строках отчётов — только роли с patients.read; руководитель/маркетолог видят агрегаты
    const pii = canSeePd(g.user)
    const pname = (last: string, first: string) => (pii ? `${last} ${first}` : HIDDEN)

    const inPeriod = <T extends { createdAt: Date }>(rows: T[]) =>
      rows.filter((r) => r.createdAt.getTime() >= from.getTime() && r.createdAt.getTime() <= to.getTime())
    const apptPeriod = appointments.filter((a) => a.start.getTime() >= from.getTime() && a.start.getTime() <= to.getTime())
    const reports: ReportDTO[] = []

    const add = (code: string, name: string, note: string, columns: ReportColumn[], rows: Array<Array<string | number>>) => {
      reports.push({ code, name, note, columns, rows })
    }

    // ---------- Операции ----------
    if (section === 'operations') {
      // ОТЧ-01 Загрузка врачей
      // план — только рабочие дни врача (график, праздники, отпуска)
      const keys = dayKeysBetween(from, to)
      const exs = await exceptionsBetween(keys[0], keys[keys.length - 1])
      const capacity = (doctorId: string): number => Math.max(1, capacityOn(doctors.find((d) => d.id === doctorId)!, keys, exs))
      add('ОТЧ-01', 'Загрузка врачей', 'План — пропускная способность сетки расписания, факт — активные записи за период', [
        { key: 'doctor', label: 'Врач' }, { key: 'specialty', label: 'Специальность' },
        { key: 'booked', label: 'Записей' }, { key: 'capacity', label: 'План слотов' },
        { key: 'percent', label: 'Загрузка, %' },
      ], doctors.map((d) => {
        const booked = apptPeriod.filter((a) => a.doctorId === d.id && a.status !== 'CANCELED').length
        const cap = capacity(d.id)
        return [d.name, d.specialty, booked, cap, `${Math.min(100, Math.round((booked / cap) * 100))}%`]
      }))

      // ОТЧ-02 Средняя длительность приёма
      add('ОТЧ-02', 'Средняя длительность приёма', 'По плану слота в записи (мин)', [
        { key: 'doctor', label: 'Врач' }, { key: 'specialty', label: 'Специальность' },
        { key: 'avg', label: 'Средняя, мин' }, { key: 'min', label: 'Мин.' }, { key: 'max', label: 'Макс.' },
      ], doctors.map((d) => {
        const ds = apptPeriod.filter((a) => a.doctorId === d.id)
        const durations = ds.map((a) => a.duration)
        return [
          d.name, d.specialty,
          durations.length ? Math.round(durations.reduce((s, x) => s + x, 0) / durations.length) : 0,
          durations.length ? Math.min(...durations) : 0,
          durations.length ? Math.max(...durations) : 0,
        ]
      }))

      // ОТЧ-03 No-show и отмены
      add('ОТЧ-03', 'No-show и отмены по врачам', 'Доля неявок и отмен от всех приёмов врача за период', [
        { key: 'doctor', label: 'Врач' }, { key: 'total', label: 'Приёмов' },
        { key: 'noShow', label: 'Неявок' }, { key: 'canceled', label: 'Отмен' }, { key: 'rate', label: 'No-show, %' },
      ], doctors.map((d) => {
        const ds = apptPeriod.filter((a) => a.doctorId === d.id)
        const ns = ds.filter((a) => a.status === 'NO_SHOW').length
        const cn = ds.filter((a) => a.status === 'CANCELED').length
        return [d.name, ds.length, ns, cn, ds.length ? `${Math.round((ns / ds.length) * 100)}%` : '0%']
      }))

      // ОТЧ-04 Конверсия записей в визиты
      add('ОТЧ-04', 'Конверсия записей в визиты', 'Созданные визиты к активным (не отменённым) записям', [
        { key: 'total', label: 'Активных записей' }, { key: 'visits', label: 'Визитов' },
        { key: 'noVisit', label: 'Без визита' }, { key: 'conv', label: 'Конверсия, %' },
      ], (() => {
        const active = apptPeriod.filter((a) => a.status !== 'CANCELED').length
        const visitsCount = inPeriod(visits).length
        return [[active, visitsCount, Math.max(0, active - visitsCount), active ? `${Math.min(100, Math.round((visitsCount / active) * 100))}%` : '0%']]
      })())

      // ОТЧ-07 Лист ожидания
      add('ОТЧ-07', 'Лист ожидания: пополнение и конверсия', 'Все заявки за период по статусам (ТУ-004: ≥ 30% замещения)', [
        { key: 'status', label: 'Статус' }, { key: 'count', label: 'Заявок' },
      ], (['ACTIVE', 'OFFERED', 'BOOKED', 'DECLINED', 'EXPIRED'] as const).map((st) => [
        st, inPeriod(waiting).filter((w) => w.status === st).length,
      ]))

      // ОТЧ-26 Выработка врачей
      add('ОТЧ-26', 'Выработка и мотивация врачей', 'Визиты, выручка и средний чек по врачам за период', [
        { key: 'doctor', label: 'Врач' }, { key: 'visits', label: 'Визитов' },
        { key: 'revenue', label: 'Выручка' }, { key: 'avgCheck', label: 'Средний чек' },
      ], doctors.map((d) => {
        const ds = inPeriod(visits).filter((v) => v.doctorId === d.id)
        const rev = ds.reduce((s, v) => s + (v.price || 0), 0)
        return [d.name, ds.length, money(rev), ds.length ? money(Math.round(rev / ds.length)) : '—']
      }))
    }

    // ---------- Маркетинг ----------
    if (section === 'marketing') {
      const SRC = { REGISTRAR: 'Регистратура', WIDGET: 'Виджет', PHONE: 'Звонок' }
      // ОТЧ-05 Конверсия обращений в записи
      add('ОТЧ-05', 'Конверсия обращений в записи', 'Записи по источникам обращения', [
        { key: 'source', label: 'Источник' }, { key: 'appts', label: 'Записей' }, { key: 'share', label: 'Доля, %' },
      ], Object.entries(SRC).map(([k, v]) => {
        const cnt = apptPeriod.filter((a) => a.source === k).length
        return [v, cnt, apptPeriod.length ? `${Math.round((cnt / apptPeriod.length) * 100)}%` : '0%']
      }))

      // ОТЧ-06 Источники первичных обращений
      add('ОТЧ-06', 'Источники первичных обращений', 'Источник первой записи нового пациента', [
        { key: 'source', label: 'Источник' }, { key: 'patients', label: 'Новых пациентов' },
      ], Object.entries(SRC).map(([k, v]) => {
        const firsts = new Map<string, string>()
        for (const a of appointments.filter((x) => x.status !== 'CANCELED').sort((a, b) => a.start.getTime() - b.start.getTime())) {
          if (!firsts.has(a.patientId)) firsts.set(a.patientId, a.source)
        }
        const cnt = [...firsts.values()].filter((s) => s === k).length
        return [v, cnt]
      }))

      // ОТЧ-27 Эффективность рассылок
      add('ОТЧ-27', 'Эффективность рассылок', 'Центр уведомлений (ФТ-013): доставка и ответы по типам сообщений', [
        { key: 'kind', label: 'Тип' }, { key: 'total', label: 'Отправлено' },
        { key: 'delivered', label: 'Доставлено' }, { key: 'failed', label: 'Ошибок' }, { key: 'responses', label: 'Ответов' },
      ], ['REMINDER', 'WAITLIST_OFFER', 'RISK_TOUCH', 'MANUAL', 'STOCK_LOW'].map((k) => {
        const rows = inPeriod(notifications).filter((n) => n.kind === k)
        const sent = rows.filter((n) => n.status === 'SENT').length
        const failed = rows.filter((n) => n.status === 'FAILED' || n.status === 'BLOCKED_BLACKLIST').length
        const responses = k === 'REMINDER'
          ? inPeriod(reminders).filter((r) => r.response !== null).length
          : 0
        return [k, rows.length, sent, failed, responses]
      }))
    }

    // ---------- Пациенты ----------
    if (section === 'patients') {
      // ОТЧ-08 Новые и повторные пациенты
      add('ОТЧ-08', 'Новые и повторные пациенты', 'Первый визит в периоде — новый; последующие — повторный', [
        { key: 'kind', label: 'Категория' }, { key: 'count', label: 'Пациентов' },
      ], (() => {
        const periodVisits = inPeriod(visits)
        const firstVisit = new Map<string, Date>()
        for (const v of visits.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
          if (!firstVisit.has(v.patientId)) firstVisit.set(v.patientId, v.createdAt)
        }
        const seen = new Set<string>()
        let newP = 0
        let ret = 0
        for (const v of periodVisits) {
          const first = firstVisit.get(v.patientId)!
          if (first.getTime() >= from.getTime() && first.getTime() <= to.getTime()) {
            if (!seen.has(v.patientId)) { newP++; seen.add(v.patientId) }
          } else ret++
        }
        return [['Новые (первый визит в периоде)', newP], ['Повторные визиты', ret]]
      })())

      // ОТЧ-12 Демография
      add('ОТЧ-12', 'Демография пациентской базы', 'Возрастные группы и пол', [
        { key: 'group', label: 'Возрастная группа' }, { key: 'total', label: 'Всего' }, { key: 'female', label: 'Жен.' }, { key: 'male', label: 'Муж.' },
      ], (() => {
        const buckets = ['0–17', '18–34', '35–49', '50–64', '65+']
        const now = new Date()
        return buckets.map((b, i) => {
          const inb = patients.filter((p) => {
            if (!p.birthDate) return false
            const age = now.getFullYear() - p.birthDate.getFullYear()
            const lo = [0, 18, 35, 50, 65][i]
            const hi = [17, 34, 49, 64, 200][i]
            return age >= lo && age <= hi
          })
          return [b, inb.length, inb.filter((p) => p.gender === 'F').length, inb.filter((p) => p.gender === 'M').length]
        })
      })())
    }

    // ---------- Комплаенс ----------
    if (section === 'compliance') {
      // ОТЧ-13 Пациенты по МКБ-10
      add('ОТЧ-13', 'Пациенты по диагнозам МКБ-10', 'Уникальные пациенты по кодам диагнозов визитов', [
        { key: 'code', label: 'МКБ-10' }, { key: 'name', label: 'Диагноз' }, { key: 'patients', label: 'Пациентов' },
      ], (() => {
        const byCode = new Map<string, Set<string>>()
        const names = new Map<string, string>()
        for (const v of visits) {
          if (!v.diagnosisCode) continue
          if (!byCode.has(v.diagnosisCode)) byCode.set(v.diagnosisCode, new Set())
          byCode.get(v.diagnosisCode)!.add(v.patientId)
          names.set(v.diagnosisCode, v.diagnosisName ?? '')
        }
        return [...byCode.entries()]
          .sort((a, b) => b[1].size - a[1].size)
          .slice(0, 12)
          .map(([code, set]) => [code, names.get(code) ?? '', set.size])
      })())

      // ОТЧ-31 Аудит действий
      add('ОТЧ-31', 'Аудит действий пользователей', 'Append-only журнал (ФТ-039): события за период', [
        { key: 'action', label: 'Действие' }, { key: 'count', label: 'Событий' }, { key: 'last', label: 'Последнее' },
      ], (() => {
        const byAction = new Map<string, { count: number; last: Date }>()
        for (const a of inPeriod(audit)) {
          const agg = byAction.get(a.action) || { count: 0, last: a.createdAt }
          agg.count++
          if (a.createdAt > agg.last) agg.last = a.createdAt
          byAction.set(a.action, agg)
        }
        return [...byAction.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 15)
          .map(([action, agg]) => [action, agg.count, `${ddmmHHMM(agg.last)}`])
      })())

      // ОТЧ-32 Активные сессии и лицензии
      add('ОТЧ-32', 'Активные сессии и лицензии', 'Concurrent-лицензии (точка улучшения №5)', [
        { key: 'role', label: 'Роль' }, { key: 'active', label: 'Активных' }, { key: 'released', label: 'Освобождено' },
      ], ['ADMIN', 'REGISTRAR', 'DOCTOR', 'MARKETER', 'HEAD'].map((r) => [
        r,
        sessions.filter((s) => s.user.role === r && s.status === 'ACTIVE').length,
        sessions.filter((s) => s.user.role === r && s.status === 'RELEASED').length,
      ]))

      // ОТЧ-33 Журнал обращений к ПДн
      add('ОТЧ-33', 'Журнал обращений к ПДн', 'Кто открывал карты пациентов: фиксация в аудите (НФТ-011/152-ФЗ)', [
        { key: 'user', label: 'Сотрудник' }, { key: 'role', label: 'Роль' }, { key: 'events', label: 'Событий за период' },
      ], (() => {
        const byUser = new Map<string, { name: string; role: string; count: number }>()
        // только обращения к ПДн пациентов: чтение карт, поиск, AI-резюме
        for (const a of inPeriod(audit)) {
          if (!a.user || !(a.action.startsWith('patient.') || a.action.startsWith('ai.summary'))) continue
          const agg = byUser.get(a.user.id) || { name: a.user.name, role: a.user.role, count: 0 }
          agg.count++
          byUser.set(a.user.id, agg)
        }
        return [...byUser.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 10)
          .map((v) => [v.name, v.role, v.count])
      })())
    }

    // ---------- Финансы ----------
    if (section === 'finance') {
      const periodPayments = inPeriod(payments)
      const gross = periodPayments.filter((p) => p.type === 'PAYMENT' && p.status === 'PAID').reduce((s, p) => s + p.amount, 0)
      const refunds = periodPayments.filter((p) => p.type === 'REFUND').reduce((s, p) => s + Math.abs(p.amount), 0)

      // ОТЧ-14 Выручка по клинике
      add('ОТЧ-14', 'Выручка по клинике', 'Итоги периода: начислено, возвраты, чистая выручка', [
        { key: 'metric', label: 'Показатель' }, { key: 'value', label: 'Значение' },
      ], [
        ['Начислено (оплаты)', money(gross)],
        ['Возвраты', money(refunds)],
        ['Чистая выручка', money(gross - refunds)],
        ['Платежей за период', periodPayments.filter((p) => p.type === 'PAYMENT').length],
      ])

      // ОТЧ-15 Выручка по врачам
      add('ОТЧ-15', 'Выручка по врачам', 'Стоимость завершённых визитов', [
        { key: 'doctor', label: 'Врач' }, { key: 'visits', label: 'Визитов' }, { key: 'revenue', label: 'Выручка' },
      ], doctors.map((d) => {
        const ds = inPeriod(visits).filter((v) => v.doctorId === d.id)
        return [d.name, ds.length, money(ds.reduce((s, v) => s + (v.price || 0), 0))]
      }))

      // ОТЧ-16 Выручка по услугам
      add('ОТЧ-16', 'Выручка по услугам', 'Состав платежей (itemsJson) по номенклатуре услуг', [
        { key: 'service', label: 'Услуга' }, { key: 'qty', label: 'Продаж' }, { key: 'revenue', label: 'Выручка' },
      ], (() => {
        const byService = new Map<string, { qty: number; revenue: number }>()
        for (const p of periodPayments.filter((x) => x.type === 'PAYMENT' && x.status === 'PAID')) {
          try {
            const items = p.itemsJson ? (JSON.parse(p.itemsJson) as Array<{ name: string; price: number; qty: number }>) : []
            for (const it of items) {
              const agg = byService.get(it.name) || { qty: 0, revenue: 0 }
              agg.qty += it.qty
              agg.revenue += it.price * it.qty
              byService.set(it.name, agg)
            }
          } catch { /* некорректный JSON пропускаем */ }
        }
        return [...byService.entries()]
          .sort((a, b) => b[1].revenue - a[1].revenue)
          .slice(0, 12)
          .map(([name, agg]) => [name, agg.qty, money(agg.revenue)])
      })())

      // ОТЧ-17 Средний чек
      add('ОТЧ-17', 'Средний чек и его динамика', 'Средний чек по оплатам за период (чистыми)', [
        { key: 'metric', label: 'Показатель' }, { key: 'value', label: 'Значение' },
      ], (() => {
        const paid = periodPayments.filter((p) => p.type === 'PAYMENT' && p.status === 'PAID')
        const avg = paid.length ? Math.round((gross - refunds) / paid.length) : 0
        return [['Оплат', paid.length], ['Средний чек', money(avg)], ['Чистая выручка', money(gross - refunds)]]
      })())

      // ОТЧ-18 Взаиморасчёты с пациентами
      add('ОТЧ-18', 'Взаиморасчёты с пациентами', 'Оплаты и возвраты по пациентам (топ по обороту)', [
        { key: 'patient', label: 'Пациент' }, { key: 'card', label: 'Карта' },
        { key: 'paid', label: 'Оплачено' }, { key: 'refunded', label: 'Возвраты' }, { key: 'net', label: 'Итого' },
      ], (() => {
        const byPatient = new Map<string, { name: string; card: string; paid: number; refunded: number }>()
        for (const p of periodPayments) {
          const agg = byPatient.get(p.patientId) || {
            name: pname(p.patient.lastName, p.patient.firstName),
            card: pii ? p.patient.cardNumber : '—',
            paid: 0,
            refunded: 0,
          }
          if (p.type === 'PAYMENT' && p.status === 'PAID') agg.paid += p.amount
          if (p.type === 'REFUND') agg.refunded += Math.abs(p.amount)
          byPatient.set(p.patientId, agg)
        }
        return [...byPatient.values()]
          .sort((a, b) => b.paid - a.paid)
          .slice(0, 10)
          .map((v) => [v.name, v.card, money(v.paid), money(v.refunded), money(v.paid - v.refunded)])
      })())

      // ОТЧ-19 ДМС
      add('ОТЧ-19', 'Взаиморасчёты с ДМС', 'Реестры услуг по страховым: подачи, оплаты, отказы', [
        { key: 'insurer', label: 'Страховая' }, { key: 'claims', label: 'Услуг' },
        { key: 'paid', label: 'Оплачено' }, { key: 'denied', label: 'Отказов' }, { key: 'revenue', label: 'Возмещение' },
      ], (() => {
        const byInsurer = new Map<string, { claims: number; paid: number; denied: number; revenue: number }>()
        for (const c of inPeriod(claims)) {
          const agg = byInsurer.get(c.insurer) || { claims: 0, paid: 0, denied: 0, revenue: 0 }
          agg.claims++
          if (c.status === 'PAID') { agg.paid++; agg.revenue += c.amount }
          if (c.status === 'DENIED') agg.denied++
          byInsurer.set(c.insurer, agg)
        }
        return [...byInsurer.entries()].map(([insurer, agg]) => [
          insurer, agg.claims, agg.paid, agg.denied, money(agg.revenue),
        ])
      })())

      // ОТЧ-20 Реестр оказанных услуг. Диагноз — врачебная тайна: колонка МКБ-10
      // только для medical.read; остальным — реестр без диагноза.
      add('ОТЧ-20', 'Реестр оказанных услуг', medical ? 'Завершённые визиты периода: врач, диагноз, стоимость' : 'Завершённые визиты периода: врач, стоимость (диагноз скрыт — врачебная тайна)', [
        { key: 'date', label: 'Дата' }, { key: 'patient', label: 'Пациент' }, { key: 'doctor', label: 'Врач' },
        ...(medical ? [{ key: 'diagnosis', label: 'МКБ-10' }] : []), { key: 'price', label: 'Стоимость' },
      ], inPeriod(visits)
        .filter((v) => v.diagnosisCode)
        .slice(0, 20)
        .map((v) => [
          `${ddmm(v.createdAt)}`,
          pname(v.patient.lastName, v.patient.firstName),
          v.doctor.name,
          ...(medical ? [`${v.diagnosisCode} — ${v.diagnosisName ?? ''}`] : []),
          money(v.price || 0),
        ]))

      // ОТЧ-21 Кассовый отчёт
      add('ОТЧ-21', 'Кассовый отчёт (X-сводка)', 'По способам оплаты: начислено, возвраты, итого (54-ФЗ)', [
        { key: 'method', label: 'Способ' }, { key: 'gross', label: 'Начислено' }, { key: 'refunds', label: 'Возвраты' }, { key: 'net', label: 'Итого' },
      ], ['CASH', 'CARD', 'SBP'].map((m) => {
        const grossM = periodPayments.filter((p) => p.method === m && p.type === 'PAYMENT' && p.status === 'PAID').reduce((s, p) => s + p.amount, 0)
        const refM = periodPayments.filter((p) => p.method === m && p.type === 'REFUND').reduce((s, p) => s + Math.abs(p.amount), 0)
        const label = { CASH: 'Наличные', CARD: 'Карта', SBP: 'СБП' }[m]!
        return [label, money(grossM), money(refM), money(grossM - refM)]
      }))

      // ОТЧ-22 Журнал платежей
      add('ОТЧ-22', 'Журнал платежей и возвратов', 'Последние операции кассы периода', [
        { key: 'time', label: 'Время' }, { key: 'patient', label: 'Пациент' }, { key: 'type', label: 'Тип' },
        { key: 'method', label: 'Способ' }, { key: 'amount', label: 'Сумма' }, { key: 'fiscal', label: 'Фискализация' },
      ], periodPayments.slice(0, 20).map((p) => [
        `${ddmmHHMM(p.createdAt)}`,
        pname(p.patient.lastName, p.patient.firstName),
        p.type === 'REFUND' ? 'Возврат' : 'Оплата',
        { CASH: 'Наличные', CARD: 'Карта', SBP: 'СБП' }[p.method] ?? p.method,
        money(Math.abs(p.amount)),
        p.fiscalStatus === 'ISSUED' ? `чек ${p.fiscalNumber ?? ''}` : 'в очереди ОФД',
      ]))

      // ОТЧ-30 Продажи по позициям прайса — дублирует ОТЧ-16 по количеству
      add('ОТЧ-30', 'Продажи по позициям прайс-листа', 'Количество продаж услуг (itemsJson платежей)', [
        { key: 'service', label: 'Услуга' }, { key: 'qty', label: 'Продаж' }, { key: 'revenue', label: 'Выручка' },
      ], (() => {
        const byService = new Map<string, { qty: number; revenue: number }>()
        for (const p of periodPayments.filter((x) => x.type === 'PAYMENT' && x.status === 'PAID')) {
          try {
            const items = p.itemsJson ? (JSON.parse(p.itemsJson) as Array<{ name: string; price: number; qty: number }>) : []
            for (const it of items) {
              const agg = byService.get(it.name) || { qty: 0, revenue: 0 }
              agg.qty += it.qty
              agg.revenue += it.price * it.qty
              byService.set(it.name, agg)
            }
          } catch { /* skip */ }
        }
        return [...byService.entries()]
          .sort((a, b) => b[1].qty - a[1].qty)
          .slice(0, 12)
          .map(([name, agg]) => [name, agg.qty, money(agg.revenue)])
      })())
    }

    // ---------- Склад ----------
    if (section === 'stock') {
      // ОТЧ-23 Остатки
      add('ОТЧ-23', 'Складские остатки', 'Остаток, минимум и стоимость позиции', [
        { key: 'item', label: 'Позиция' }, { key: 'sku', label: 'SKU' }, { key: 'qty', label: 'Остаток' },
        { key: 'min', label: 'Мин.' }, { key: 'value', label: 'Стоимость' }, { key: 'flag', label: 'Ниже минимума' },
      ], stockItems.map((i) => [
        i.name, i.sku, `${i.qty} ${i.unit}`, i.minQty, money(i.qty * i.price), i.qty < i.minQty ? 'ДА' : '—',
      ]))

      // ОТЧ-24 Движение ТМЦ
      add('ОТЧ-24', 'Движение ТМЦ', 'Приход / расход / списание по типам за период', [
        { key: 'type', label: 'Тип' }, { key: 'count', label: 'Операций' }, { key: 'qty', label: 'Единиц' }, { key: 'cost', label: 'Стоимость' },
      ], ['IN', 'OUT', 'WRITEOFF', 'INVENTORY'].map((t) => {
        const ms = inPeriod(movements).filter((m) => m.type === t)
        return [
          { IN: 'Приход', OUT: 'Расход (на визит)', WRITEOFF: 'Списание', INVENTORY: 'Инвентаризация' }[t] ?? t,
          ms.length,
          ms.reduce((s, m) => s + m.qty, 0),
          money(ms.reduce((s, m) => s + m.qty * m.price, 0)),
        ]
      }))

      // ОТЧ-25 Себестоимость визита
      add('ОТЧ-25', 'Расход материалов на визит', 'Средняя себестоимость списания на визит (ОТЧ-25, v2-статус)', [
        { key: 'metric', label: 'Показатель' }, { key: 'value', label: 'Значение' },
      ], (() => {
        const outs = inPeriod(movements).filter((m) => m.type === 'OUT')
        const visitIds = new Set(outs.map((m) => m.visitId))
        const totalCost = outs.reduce((s, m) => s + m.qty * m.price, 0)
        return [
          ['Визитов со списанием', visitIds.size],
          ['Списано единиц', outs.reduce((s, m) => s + m.qty, 0)],
          ['Себестоимость списаний', money(totalCost)],
          ['Средняя себестоимость визита', visitIds.size ? money(Math.round(totalCost / visitIds.size)) : '—'],
        ]
      })())
    }

    // ---------- Персонал ----------
    if (section === 'staff') {
      add('ОТЧ-26', 'Выработка врачей (мотивация)', 'База мотивации: визиты, выручка, средний чек за период', [
        { key: 'doctor', label: 'Врач' }, { key: 'specialty', label: 'Специальность' },
        { key: 'visits', label: 'Визитов' }, { key: 'revenue', label: 'Выручка' }, { key: 'avg', label: 'Средний чек' },
      ], doctors.map((d) => {
        const ds = inPeriod(visits).filter((v) => v.doctorId === d.id)
        const rev = ds.reduce((s, v) => s + (v.price || 0), 0)
        return [d.name, d.specialty, ds.length, money(rev), ds.length ? money(Math.round(rev / ds.length)) : '—']
      }))
    }

    // ---------- Предиктив ----------
    if (section === 'predictive') {
      // ОТЧ-34 Прогноз загрузки на 14 дней
      const forecastEx = await exceptionsBetween(dateKey(clinicDayStart(0)), dateKey(clinicDayStart(14)))
      add('ОТЧ-34', 'Прогноз загрузки врачей на 14 дней', 'Свободная пропускная способность сетки минус занятые слоты', [
        { key: 'day', label: 'День' }, { key: 'capacity', label: 'План' }, { key: 'booked', label: 'Записано' }, { key: 'free', label: 'Свободно' },
      ], (() => {
        const rows: Array<Array<string | number>> = []
        for (let i = 0; i < 14; i++) {
          const day = clinicDayStart(i)
          const dayEndTs = clinicDayStart(i + 1)
          let cap = 0
          let booked = 0
          for (const doc of doctors) cap += capacityOn(doc, [dateKey(day)], forecastEx)
          for (const a of appointments) {
            if (a.start >= day && a.start < dayEndTs && a.status !== 'CANCELED') booked++
          }
          rows.push([
            `${ddmm(day)} (${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][zonedParts(day).weekday]})`,
            cap, booked, cap - booked,
          ])
        }
        return rows
      })())

      // ОТЧ-35 Прогноз выручки на 30 дней
      add('ОТЧ-35', 'Прогноз выручки на 30 дней', 'Средняя дневная выручка за период × 30 (MAPE-модель v2)', [
        { key: 'metric', label: 'Показатель' }, { key: 'value', label: 'Значение' },
      ], (() => {
        const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400_000))
        const revenuePeriod = inPeriod(visits).reduce((s, v) => s + (v.price || 0), 0)
        const daily = Math.round(revenuePeriod / days)
        return [
          ['Выручка за период', money(revenuePeriod)],
          ['Средняя в день', money(daily)],
          ['Прогноз на 30 дней', money(daily * 30)],
        ]
      })())

      // ОТЧ-36 Риск оттока
      add('ОТЧ-36', 'Список риска оттока', 'Пациенты, давно не посещавшие клинику: скор по давности и истории', [
        { key: 'patient', label: 'Пациент' }, { key: 'last', label: 'Последний визит' },
        { key: 'visits', label: 'Визитов' }, { key: 'monthsAgo', label: 'Месяцев назад' }, { key: 'risk', label: 'Скор' },
      ], (() => {
        const rows: Array<Array<string | number>> = []
        for (const p of patients) {
          const pv = visits.filter((v) => v.patientId === p.id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          if (pv.length === 0) continue
          const last = pv[0].createdAt
          const monthsAgo = Math.floor((Date.now() - last.getTime()) / (30 * 86400_000))
          if (monthsAgo < 6) continue
          const risk = Math.min(95, 40 + monthsAgo * 8 + (pv.length < 3 ? 15 : 0))
          rows.push([
            pname(p.lastName, p.firstName),
            `${ddmmyyyy(last)}`,
            pv.length,
            monthsAgo,
            risk,
          ])
        }
        return rows.sort((a, b) => Number(b[4]) - Number(a[4])).slice(0, 10)
      })())
    }

    return NextResponse.json({
      catalog: CATALOG.filter((c) => allowed.includes(c.section as never)),
      sections: allowed,
      section,
      period: { from: iso(from), to: iso(to) },
      reports,
    })
  } catch (e) {
    console.error('[reports GET]', e)
    return NextResponse.json({ error: 'Не удалось сформировать отчёты' }, { status: 500 })
  }
}
