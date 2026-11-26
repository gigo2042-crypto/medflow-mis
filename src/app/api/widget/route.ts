// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { checkSlot, exceptionsBetween } from '@/lib/schedule-days'
import { hoursOn } from '@/lib/appointment-rules'
import { clinicBrand } from '@/lib/clinic'
import { db } from '@/lib/db'
import { audit, getSessionUser } from '@/lib/auth-server'
import { addDaysKey, clinicDayStart, clinicMinutes, ddmm, minutesOf, normalizePhone, pad2, parseDateKey, timeStr, todayKey, zonedTime } from '@/lib/mis-utils'
import { WIDGET_DRAFT_SCRUB, expireWidgetDrafts } from '@/lib/waiting'
import { createCascade } from '@/lib/reminders'
import { WidgetConfigDTO, WidgetDayDTO } from '@/lib/types'
import { randomInt, timingSafeEqual } from 'crypto'
import { isDemo, isProduction } from '@/lib/config'
import { hit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/request-ip'
import { captchaSiteKey, verifyCaptcha } from '@/lib/captcha'
import { smsAdapter } from '@/lib/sms'
import { createPatientWithCard, findPatientForBooking } from '@/lib/patients'
import { currentPdConsent, recordConsent } from '@/lib/consent'
import { maxConfig, maxDeeplink } from '@/lib/max'
import { signLink } from '@/lib/patient-links'

export const dynamic = 'force-dynamic'

// Публичный эндпоинт embeddable-виджета онлайн-записи (ФТ-012, ТУ-008).
// Без аутентификации: пациент не сотрудник. Защита: лимиты по IP и телефону в БД,
// капча (SmartCaptcha, если настроена), код подтверждения уходит только по SMS
// (в демо — показывается на экране), не более 5 попыток ввода кода.
const INIT_IP_LIMIT = 10 // попыток init с одного IP в час
const INIT_PHONE_LIMIT = 3 // SMS на один номер в час
const CONFIRM_MAX_ATTEMPTS = 5
const CONFIRM_IP_LIMIT = 30 // попыток ввода кода с одного IP в час (по всем черновикам)

const HOLD_MINUTES = 15 // удержание слота на время подтверждения (КП-017)
const ACTIVE_APPT = ['BOOKED', 'CONFIRMED', 'ARRIVED', 'DONE']

function dayStartOf(offsetDays: number): Date {
  return clinicDayStart(offsetDays)
}

function dayLabel(d: Date, offset: number): string {
  const base = offset === 0 ? 'Сегодня' : offset === 1 ? 'Завтра' : 'Послезавтра'
  return `${base} · ${ddmm(d)}`
}

// GET: конфигурация виджета + свободные слоты на 3 дня
function widgetDisabled(): boolean {
  return isProduction() && process.env.WIDGET_ENABLED === '0'
}

// GET без побочных эффектов: истёкшие черновики просто не учитываются (их гасит POST и планировщик)
export async function GET(req: NextRequest) {
  if (widgetDisabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const doctors = await db.doctor.findMany({ orderBy: { name: 'asc' } })
    const services = await db.serviceItem.findMany({ where: { active: true }, orderBy: { category: 'asc' } })
    const rangeStart = dayStartOf(0)
    const rangeEnd = dayStartOf(3)
    const appts = await db.appointment.findMany({
      where: { start: { gte: rangeStart, lt: rangeEnd }, status: { in: ACTIVE_APPT } },
    })
    const drafts = await db.widgetDraft.findMany({ where: { status: 'PENDING', expiresAt: { gt: new Date() } } })
    const blocked = new Set<string>()
    for (const a of appts) blocked.add(`${a.doctorId}@${a.start.getTime()}`)
    for (const d of drafts) blocked.add(`${d.doctorId}@${d.start.getTime()}`)

    const now = Date.now()
    const exceptions = await exceptionsBetween(todayKey(), addDaysKey(todayKey(), 2))
    const days: WidgetDayDTO[] = []
    const nearestByDoctor = new Map<string, { date: string; time: string }>()
    for (let off = 0; off < 3; off++) {
      const day = dayStartOf(off)
      const label = dayLabel(day, off)
      const dateStr = addDaysKey(todayKey(), off)
      const dk = parseDateKey(dateStr)!
      const doctorsOfDay = doctors.map((doc) => {
        // выходные по графику, праздники и отпуска — без слотов
        const hours = hoursOn(doc, dateStr, exceptions)
        if (hours.off) return { doctorId: doc.id, slots: [] as Array<{ start: string; time: string }> }
        const [sh, sm] = hours.workStart.split(':').map(Number)
        const [eh, em] = hours.workEnd.split(':').map(Number)
        const start0 = zonedTime(dk.y, dk.m, dk.d, sh, sm)
        const end0 = zonedTime(dk.y, dk.m, dk.d, eh, em)
        const slots: Array<{ start: string; time: string }> = []
        for (let t = start0.getTime(); t < end0.getTime(); t += doc.slotMinutes * 60_000) {
          if (t <= now) continue // прошедшие слоты не показываем
          if (blocked.has(`${doc.id}@${t}`)) continue
          const s = new Date(t)
          if (!nearestByDoctor.has(doc.id)) {
            nearestByDoctor.set(doc.id, { date: dateStr, time: `${timeStr(s)}` })
          }
          slots.push({ start: s.toISOString(), time: `${timeStr(s)}` })
        }
        return { doctorId: doc.id, slots }
      })
      days.push({ date: dateStr, label, doctors: doctorsOfDay })
    }

    // Направления для первого шага виджета
    const bySpec = new Map<string, Array<{ id: string; name: string; specialty: string; nearest?: { date: string; time: string } | null }>>()
    for (const doc of doctors) {
      const list = bySpec.get(doc.specialty) || []
      list.push({ id: doc.id, name: doc.name, specialty: doc.specialty, nearest: nearestByDoctor.get(doc.id) ?? null })
      bySpec.set(doc.specialty, list)
    }

    // Счётчики записей — только сотрудникам (публично не раскрываем объёмы клиники)
    let stats: WidgetConfigDTO['stats'] = null
    if (await getSessionUser(req)) {
      const today0 = dayStartOf(0)
      const weekAgo = new Date(today0.getTime() - 7 * 86400_000)
      const [todayWidget, weekWidget] = await Promise.all([
        db.appointment.count({ where: { source: 'WIDGET', start: { gte: today0 } } }),
        db.appointment.count({ where: { source: 'WIDGET', start: { gte: weekAgo } } }),
      ])
      stats = { today: todayWidget, week: weekWidget }
    }
    const consent = await currentPdConsent()

    const config: WidgetConfigDTO = {
      clinicName: clinicBrand(),
      directions: Array.from(bySpec.entries()).map(([specialty, docs]) => ({ specialty, doctors: docs })),
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category,
        price: s.price,
        durationMinutes: s.durationMinutes,
      })),
      days,
      stats,
      consent: consent ? { text: consent.text, version: consent.version } : null,
      captchaSiteKey: captchaSiteKey(),
      demo: isDemo(),
    }
    return NextResponse.json(config)
  } catch (e) {
    console.error('[widget GET]', e)
    return NextResponse.json({ error: 'Не удалось загрузить виджет' }, { status: 500 })
  }
}

// POST: двухшаговая запись — init (удержание слота + SMS-код) и confirm (ФТ-012)
export async function POST(req: NextRequest) {
  if (widgetDisabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    await expireWidgetDrafts()
    const body = await req.json()
    const action = body.action

    if (action === 'init') {
      const { doctorId, start, name, phone, serviceId, captchaToken } = body
      if (!doctorId || !start || !name || !phone) {
        return NextResponse.json({ error: 'Заполните все поля' }, { status: 400 })
      }
      // 152-ФЗ ст.9/10: без утверждённого текста согласия и галочки пациента запись не принимаем
      const consent = await currentPdConsent()
      if (!consent) return NextResponse.json({ error: 'Онлайн-запись временно недоступна: клиника не утвердила текст согласия на обработку персональных данных. Позвоните в клинику.' }, { status: 503 })
      if (body.consent !== true || (body.consentVersion && body.consentVersion !== consent.version)) {
        return NextResponse.json({ error: 'Нужно согласие на обработку персональных данных' }, { status: 400 })
      }
      const ip = clientIp(req)
      const ipLimit = await hit(`widget:ip:${ip}`, INIT_IP_LIMIT, 3600_000, 3600_000)
      if (!ipLimit.allowed) return NextResponse.json({ error: 'Слишком много попыток записи. Попробуйте позже или позвоните в клинику.' }, { status: 429 })
      if (!(await verifyCaptcha(captchaToken, ip))) {
        return NextResponse.json({ error: 'Подтвердите, что вы не робот' }, { status: 400 })
      }
      const doctor = await db.doctor.findUnique({ where: { id: String(doctorId) } })
      if (!doctor) return NextResponse.json({ error: 'Врач не найден' }, { status: 404 })
      const startDt = new Date(start)
      if (Number.isNaN(startDt.getTime()) || (await checkSlot(doctor, startDt))) {
        return NextResponse.json({ error: 'Слот недоступен' }, { status: 400 })
      }
      if (String(name).trim().length < 3 || String(name).length > 120) {
        return NextResponse.json({ error: 'Укажите фамилию и имя' }, { status: 400 })
      }
      const phoneN = normalizePhone(String(phone))
      if (phoneN.length < 10 || phoneN.length > 12) {
        return NextResponse.json({ error: 'Укажите телефон в формате +7…' }, { status: 400 })
      }
      const phoneLimit = await hit(`widget:phone:${phoneN}`, INIT_PHONE_LIMIT, 3600_000, 3600_000)
      if (!phoneLimit.allowed) return NextResponse.json({ error: 'На этот номер уже отправлено несколько кодов. Попробуйте через час.' }, { status: 429 })
      // Слот должен быть свободен (учитывая удержания других черновиков)
      const busy = await db.appointment.findFirst({
        where: { doctorId: doctor.id, start: startDt, status: { in: ACTIVE_APPT } },
      })
      const held = await db.widgetDraft.findFirst({
        where: { doctorId: doctor.id, start: startDt, status: 'PENDING', expiresAt: { gt: new Date() } },
      })
      if (busy || held) {
        return NextResponse.json({ error: 'Слот уже занят — выберите другой' }, { status: 409 })
      }
      const code = String(randomInt(100000, 1000000))
      const draft = await db.widgetDraft.create({
        data: {
          doctorId: doctor.id,
          start: startDt,
          serviceId: serviceId ? String(serviceId) : null,
          name: String(name).trim(),
          phone: phoneN,
          code,
          consentVersion: consent.version,
          consentHash: consent.hash,
          consentIp: ip,
          marketingConsent: body.marketingConsent === true,
          expiresAt: new Date(Date.now() + HOLD_MINUTES * 60_000),
        },
      })
      const sms = await smsAdapter().send(phoneN, `Код подтверждения записи: ${code}. Никому не сообщайте его.`)
      if (!sms.ok && !isDemo()) {
        await db.widgetDraft.update({ where: { id: draft.id }, data: { status: 'EXPIRED', ...WIDGET_DRAFT_SCRUB } })
        return NextResponse.json({ error: 'Не удалось отправить SMS с кодом. Попробуйте позже или позвоните в клинику.' }, { status: 503 })
      }
      const out: Record<string, unknown> = {
        draftId: draft.id,
        holdMinutes: HOLD_MINUTES,
        expiresAt: draft.expiresAt.toISOString(),
        demo: isDemo(),
      }
      // Код в ответе — только на демо-стенде (наружу SMS там не уходят)
      if (isDemo()) out.code = code
      return NextResponse.json(out)
    }

    if (action === 'confirm') {
      const { draftId, code } = body
      if (!draftId || !code) return NextResponse.json({ error: 'Укажите draftId и код' }, { status: 400 })
      // Лимит по IP: перебор кодов по многим черновикам с одного адреса
      const confirmIp = clientIp(req)
      const ipLimit = await hit(`widget:confirm:ip:${confirmIp}`, CONFIRM_IP_LIMIT, 3600_000, 3600_000)
      if (!ipLimit.allowed) return NextResponse.json({ error: 'Слишком много попыток. Попробуйте позже или позвоните в клинику.' }, { status: 429 })
      // Попытка резервируется одним SQL до сравнения кода (параллельные запросы не обходят лимит 5)
      const reserved = await db.$queryRaw<Array<{ attempts: number }>>`
        UPDATE "WidgetDraft" SET "attempts" = "attempts" + 1
        WHERE "id" = ${String(draftId)} AND "status" = 'PENDING' AND "attempts" < ${CONFIRM_MAX_ATTEMPTS}
          AND "expiresAt" > ${new Date().toISOString()}::timestamp
        RETURNING "attempts"`
      const draft = reserved.length ? await db.widgetDraft.findUnique({ where: { id: String(draftId) } }) : null
      if (!draft) {
        const left = await db.widgetDraft.findUnique({ where: { id: String(draftId) }, select: { attempts: true, status: true } })
        if (left && left.status === 'PENDING' && left.attempts >= CONFIRM_MAX_ATTEMPTS) {
          await db.widgetDraft.updateMany({ where: { id: String(draftId), status: 'PENDING' }, data: { status: 'EXPIRED', ...WIDGET_DRAFT_SCRUB } })
          return NextResponse.json({ error: 'Превышено число попыток — начните запись заново' }, { status: 429 })
        }
        return NextResponse.json({ error: 'Код истёк — начните запись заново' }, { status: 400 })
      }
      const given = Buffer.from(String(code).trim())
      const expected = Buffer.from(draft.code)
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        const attempts = reserved[0].attempts
        if (attempts >= CONFIRM_MAX_ATTEMPTS) {
          await db.widgetDraft.updateMany({ where: { id: draft.id, status: 'PENDING' }, data: { status: 'EXPIRED', ...WIDGET_DRAFT_SCRUB } })
          return NextResponse.json({ error: 'Превышено число попыток — начните запись заново' }, { status: 429 })
        }
        return NextResponse.json({ error: 'Неверный код из SMS' }, { status: 400 })
      }
      // Слот мог быть занят за время удержания
      const busy = await db.appointment.findFirst({
        where: { doctorId: draft.doctorId, start: draft.start, status: { in: ACTIVE_APPT } },
      })
      if (busy) {
        await db.widgetDraft.update({ where: { id: draft.id }, data: { status: 'EXPIRED', ...WIDGET_DRAFT_SCRUB } })
        return NextResponse.json({ error: 'Слот уже занят — выберите другой' }, { status: 409 })
      }
      const doctor = await db.doctor.findUnique({ where: { id: draft.doctorId } })
      if (!doctor) return NextResponse.json({ error: 'Врач не найден' }, { status: 404 })

      // Идентификация: телефон + фамилия (запрос по индексу, без загрузки картотеки).
      // Имя из карты в ответе не раскрываем — показываем то, что ввёл пациент.
      // Пациент, приём, согласия, напоминания и захват черновика — одной транзакцией (чек-лист P1):
      // либо запись создана целиком, либо ничего (нет «пациента без согласия» и приёма без напоминаний).
      const patientName = draft.name
      const ip = clientIp(req)
      let booked: { appointment: { id: string }; patientId: string; isNew: boolean; remindersCreated: number }
      try {
        booked = await db.$transaction(async (tx) => {
          // черновик подтверждается ровно один раз (параллельные confirm с верным кодом)
          const claim = await tx.widgetDraft.updateMany({
            where: { id: draft.id, status: 'PENDING' },
            data: { status: 'CONFIRMED', ...WIDGET_DRAFT_SCRUB },
          })
          if (claim.count !== 1) throw new DraftTaken()
          const found = await findPatientForBooking(draft.phone, draft.name, tx)
          let patientId = found?.id
          if (!patientId) {
            const parts = draft.name.trim().split(/\s+/)
            const created = await createPatientWithCard(
              {
                lastName: parts[0] || draft.name,
                firstName: parts.slice(1).join(' ') || '—',
                phone: draft.phone,
                notes: 'Пациент записался сам через виджет онлайн-записи (ФТ-012)',
              },
              tx
            )
            patientId = created.id
          }
          const appointment = await tx.appointment.create({
            data: { patientId, doctorId: draft.doctorId, start: draft.start, duration: doctor.slotMinutes, source: 'WIDGET', status: 'BOOKED' },
          })
          await recordConsent({ patientId, kind: 'PD', action: 'GIVEN', source: 'WIDGET', version: draft.consentVersion, textHash: draft.consentHash, ip: draft.consentIp || ip }, tx)
          if (draft.marketingConsent) await recordConsent({ patientId, kind: 'MARKETING', action: 'GIVEN', source: 'WIDGET', ip: draft.consentIp || ip }, tx)
          const remindersCreated = await createCascade(appointment.id, tx)
          return { appointment, patientId, isNew: !found, remindersCreated }
        })
      } catch (e) {
        if (e instanceof DraftTaken) return NextResponse.json({ error: 'Запись по этому коду уже подтверждена или истекла' }, { status: 409 })
        // частичный уникальный индекс Appointment_active_slot_key: слот заняли параллельно
        if ((e as { code?: string }).code === 'P2002') {
          await db.widgetDraft.updateMany({ where: { id: draft.id, status: 'PENDING' }, data: { status: 'EXPIRED', ...WIDGET_DRAFT_SCRUB } })
          return NextResponse.json({ error: 'Слот уже занят — выберите другой' }, { status: 409 })
        }
        throw e
      }
      const { appointment, patientId, remindersCreated } = booked
      const patient = booked.isNew ? null : { id: patientId }
      await audit('widget.booking_created', null, {
        appointmentId: appointment.id,
        doctorId: draft.doctorId,
        start: draft.start.toISOString(),
        newPatient: !patient,
      })
      // Приглашение в бот MAX: пациент подтвердил телефон кодом, поэтому ссылку можно показать.
      // Привязка произойдёт, только когда он сам откроет бота и нажмёт «Начать».
      const linked = await db.patient.findUnique({ where: { id: patientId }, select: { maxUserId: true } })
      const maxInviteUrl = !linked?.maxUserId && (maxConfig().configured || isDemo()) ? maxDeeplink(signLink('max', patientId)) : null
      // ТУ-008: мгновенное подтверждение брони — без оператора
      return NextResponse.json(
        {
          appointment: { id: appointment.id, start: draft.start.toISOString(), doctorName: doctor.name },
          patientName,
          remindersCreated,
          instant: true,
          maxInviteUrl,
        },
        { status: 201 }
      )
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 })
  } catch (e) {
    console.error('[widget POST]', e)
    return NextResponse.json({ error: 'Не удалось оформить запись' }, { status: 500 })
  }
}

class DraftTaken extends Error {}
