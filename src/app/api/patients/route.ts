// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createPatientWithCard } from '@/lib/patients'
import { audit, requirePerm } from '@/lib/auth-server'
import { levenshtein, normalizePhone } from '@/lib/mis-utils'
import { PatientLite } from '@/lib/types'
import { Prisma } from '@prisma/client'
import { canSeeMedical, doctorFilterId } from '@/lib/pd-access'
import { recordConsent } from '@/lib/consent'
import { clientIp } from '@/lib/request-ip'
import { clinicDayStart } from '@/lib/mis-utils'

export const dynamic = 'force-dynamic'

const MAX_PAGE_SIZE = 100
const UPCOMING_DAYS = 7

// Универсальный поиск пациентов с устойчивостью к опечаткам.
// Без запроса — новые пациенты сверху (createdAt desc) с пагинацией (чеклист п.13).
// Маркетолог (patients.read_basic) получает только обезличенные поля (чеклист п.6).
export async function GET(req: NextRequest) {
  const full = await requirePerm(req, 'patients.read')
  let basicOnly = false
  let g = full
  if (!full.ok) {
    const basic = await requirePerm(req, 'patients.read_basic')
    if (!basic.ok) return full.res
    g = basic
    basicOnly = true
  }
  if (!g.ok) return g.res
  try {
    const sp = req.nextUrl.searchParams
    const q = (sp.get('q') || '').trim()
    const page = Math.max(1, Number(sp.get('page') || 1) || 1)
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(sp.get('pageSize') || 10) || 10))

    if (basicOnly) {
      const [total, rows] = await Promise.all([
        db.patient.count(),
        db.patient.findMany({
          select: { id: true, gender: true, birthDate: true, createdAt: true, _count: { select: { appointments: true } } },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ])
      return NextResponse.json({
        patients: rows.map((p) => ({
          id: p.id,
          gender: p.gender,
          birthYear: p.birthDate ? p.birthDate.getUTCFullYear() : null,
          createdAt: p.createdAt.toISOString(),
          appointmentCount: p._count.appointments,
        })),
        total,
        page,
        pageSize,
      })
    }

    const medical = canSeeMedical(g.user)
    const toLite = (p: {
      id: string; cardNumber: string; lastName: string; firstName: string; middleName: string | null; phone: string
      gender: string; birthDate: Date | null; notes: string | null; appointments: Array<{ status: string }>
    }): PatientLite => ({
      id: p.id,
      cardNumber: p.cardNumber,
      lastName: p.lastName,
      firstName: p.firstName,
      middleName: p.middleName,
      phone: p.phone,
      gender: p.gender,
      birthDate: p.birthDate ? p.birthDate.toISOString() : null,
      notes: medical ? p.notes : null, // заметки врача — только medical.read
      appointmentCount: p.appointments.length,
      noShowCount: p.appointments.filter((a) => a.status === 'NO_SHOW').length,
    })

    // Врач (DOCTOR_SCOPE=own) ищет только среди своих пациентов; обезличенные карточки скрыты
    const docId = doctorFilterId(g.user)
    const scope: Prisma.PatientWhereInput = {
      anonymizedAt: null,
      ...(docId ? { appointments: { some: { doctorId: docId } } } : {}),
    }
    if (!q) {
      // «Поиск вместо реестра» (чек-лист Тони, P0): без запроса — только пациенты с записями
      // на сегодня и ближайшие UPCOMING_DAYS дней. Вся картотека — по явному действию (all=1),
      // каждый такой листинг пишется в аудит. Обычный листинг тоже аудируется (как поиск).
      const all = sp.get('all') === '1'
      const listWhere: Prisma.PatientWhereInput = all
        ? scope
        : {
            AND: [
              scope,
              { appointments: { some: { start: { gte: clinicDayStart(0), lt: clinicDayStart(UPCOMING_DAYS + 1) }, status: { in: ['BOOKED', 'CONFIRMED', 'ARRIVED'] }, ...(docId ? { doctorId: docId } : {}) } } },
            ],
          }
      const [total, rows] = await Promise.all([
        db.patient.count({ where: listWhere }),
        db.patient.findMany({
          where: listWhere,
          include: { appointments: { select: { status: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ])
      await audit(all ? 'patient.list_all' : 'patient.list', g.user.id, { scope: all ? 'all' : `upcoming_${UPCOMING_DAYS}d`, page, results: rows.length, total })
      return NextResponse.json({ patients: rows.map(toLite), total, page, pageSize, scope: all ? 'all' : 'upcoming', upcomingDays: UPCOMING_DAYS })
    }

    // Предфильтр в БД (без выгрузки всей картотеки): совпадение по первым 3 символам
    // любого слова запроса в ФИО/карте или по цифрам телефона; опечатки дальше —
    // ранжирование Левенштейном среди кандидатов (не более SEARCH_CAP).
    const SEARCH_CAP = 500
    const ors: Prisma.PatientWhereInput[] = []
    for (const t of q.split(/\s+/).filter(Boolean)) {
      const head = t.slice(0, 3)
      ors.push(
        { lastName: { contains: head, mode: 'insensitive' } },
        { firstName: { contains: head, mode: 'insensitive' } },
        { middleName: { contains: head, mode: 'insensitive' } },
        { cardNumber: { contains: t, mode: 'insensitive' } },
      )
      const digits = t.replace(/\D/g, '')
      if (digits.length >= 3) {
        // телефоны хранятся в свободном формате — сравниваем только цифры
        const tail = `%${digits.length > 10 ? digits.slice(-10) : digits}%`
        const hits = await db.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Patient" WHERE regexp_replace(phone, '\\D', '', 'g') LIKE ${tail} LIMIT 200`
        if (hits.length) ors.push({ id: { in: hits.map((h) => h.id) } })
      }
    }
    const rows = await db.patient.findMany({
      where: { AND: [scope, { OR: ors }] },
      include: { appointments: { select: { status: true } } },
      orderBy: { createdAt: 'desc' },
      take: SEARCH_CAP,
    })
    const patients = rows.map(toLite)
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean)
    const scored = patients.map((p) => {
      const fio = `${p.lastName} ${p.firstName} ${p.middleName ?? ''}`.toLowerCase().trim()
      const fioTokens = fio.split(/\s+/)
      const phoneDigits = normalizePhone(p.phone)
      const card = p.cardNumber.toLowerCase()
      let total = 0
      let allMatched = true
      for (const t of tokens) {
        let best = 0
        const tDigits = normalizePhone(t)
        if (tDigits.length >= 3 && phoneDigits.includes(tDigits)) best = 4
        if (card.includes(t)) best = Math.max(best, 3)
        for (const ft of fioTokens) {
          if (t.length >= 3 && ft.startsWith(t)) best = Math.max(best, 3)
          else if (t.length >= 3 && ft.includes(t)) best = Math.max(best, 2)
          else if (t.length >= 4 && levenshtein(ft, t) <= 2) best = Math.max(best, 1.5)
        }
        if (best === 0) allMatched = false
        total += best
      }
      return { p, total: allMatched ? total : 0 }
    })

    scored.sort((a, b) => b.total - a.total || a.p.lastName.localeCompare(b.p.lastName))
    const matched = scored.filter((x) => x.total > 0)
    const result = matched
      .slice((page - 1) * pageSize, page * pageSize)
      .map((x) => ({ ...x.p, score: x.total }))
    await audit('patient.search', g.user.id, { results: result.length })
    return NextResponse.json({ patients: result, total: matched.length, page, pageSize })
  } catch (e) {
    console.error('[patients GET]', e)
    return NextResponse.json({ error: 'Ошибка поиска пациентов' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const g = await requirePerm(req, 'patients.create')
  if (!g.ok) return g.res
  try {
    const body = await req.json()
    const lastName = (body.lastName || '').trim()
    const firstName = (body.firstName || '').trim()
    const phone = (body.phone || '').trim()
    if (!lastName || !firstName || !phone) {
      return NextResponse.json({ error: 'Фамилия, имя и телефон обязательны' }, { status: 400 })
    }
    // 152-ФЗ ст.9/10: карта заводится только при подписанном согласии на обработку ПДн
    // (бумажный бланк в регистратуре; онлайн — через виджет с чекбоксом)
    if (body.pdConsent !== true) {
      return NextResponse.json({ error: 'Нужно подписанное согласие пациента на обработку персональных данных' }, { status: 400 })
    }
    const birthDate = body.birthDate ? new Date(body.birthDate) : null
    if (birthDate && (Number.isNaN(birthDate.getTime()) || birthDate.getTime() > Date.now())) {
      return NextResponse.json({ error: 'Некорректная дата рождения' }, { status: 400 })
    }
    // Номер карты — единая нумерация (последовательность patient_card_seq, src/lib/patients.ts);
    // карта и бумажное согласие — одной транзакцией (нет карты без зафиксированного согласия)
    const ip = clientIp(req)
    let patient: Awaited<ReturnType<typeof db.patient.create>>
    try {
      patient = await db.$transaction(async (tx) => {
        const created = await createPatientWithCard(
          {
            lastName,
            firstName,
            middleName: (body.middleName || '').trim() || null,
            phone,
            gender: body.gender === 'M' ? 'M' : 'F',
            birthDate,
          },
          tx
        )
        await recordConsent({ patientId: created.id, kind: 'PD', action: 'GIVEN', source: 'PAPER', version: String(body.pdConsentVersion || 'paper'), staffId: g.user.id, ip }, tx)
        if (body.marketingConsent === true) {
          await recordConsent({ patientId: created.id, kind: 'MARKETING', action: 'GIVEN', source: 'PAPER', staffId: g.user.id, ip }, tx)
        }
        return created
      })
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return NextResponse.json({ error: 'Не удалось выдать номер карты, повторите' }, { status: 409 })
      throw e
    }
    const cardNumber = patient.cardNumber
    // без ФИО в аудите (чеклист п.15)
    await audit('patient.created', g.user.id, { patientId: patient.id, cardNumber })
    return NextResponse.json({ patient }, { status: 201 })
  } catch (e) {
    console.error('[patients POST]', e)
    return NextResponse.json({ error: 'Не удалось создать пациента' }, { status: 500 })
  }
}
