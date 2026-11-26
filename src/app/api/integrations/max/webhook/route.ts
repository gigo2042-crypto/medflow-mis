// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { audit } from '@/lib/auth-server'
import { answerMaxCallback, maxConfig, sendMaxMessage } from '@/lib/max'
import { checkLink } from '@/lib/link-revocation'
import { linkMax, performPatientAction, unlinkMax, unsubscribeMarketing } from '@/lib/patient-actions'
import { db } from '@/lib/db'
import { clinicBrand } from '@/lib/clinic'

export const dynamic = 'force-dynamic'

// Вебхук бота MAX (POST /subscriptions → этот адрес, https, порт 443).
// Подлинность: заголовок X-Max-Bot-Api-Secret = MAX_WEBHOOK_SECRET.
// События:
//   bot_started     — пациент открыл ссылку-приглашение (payload = подписанный токен) → привязка user_id;
//   bot_stopped / dialog_removed — пациент остановил бота → привязка снимается, дальше — SMS;
//   message_created — «СТОП» → отписка от рекламы (напоминания о записях продолжаются);
//   message_callback — кнопки «Подтверждаю/Отменить», «Записаться/Не подходит».
// MAX ждёт HTTP 200 в течение 30 секунд; на ошибки обработки тоже отвечаем 200,
// чтобы не получать повторную доставку того же события.

type MaxUser = { user_id?: number | string }
type MaxUpdate = {
  update_type?: string
  user?: MaxUser
  payload?: string | null
  message?: { sender?: MaxUser; body?: { text?: string | null } } | null
  callback?: { callback_id?: string; payload?: string; user?: MaxUser }
}

const STOP_WORDS = ['стоп', 'stop', 'отписаться']

function secretOk(req: NextRequest, expected: string): boolean {
  const got = req.headers.get('x-max-bot-api-secret') || ''
  const a = Buffer.from(got)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const uid = (u?: MaxUser) => (u?.user_id !== undefined && /^\d+$/.test(String(u.user_id)) ? String(u.user_id) : null)

export async function POST(req: NextRequest) {
  const cfg = maxConfig()
  if (!cfg.configured) return NextResponse.json({ error: 'MAX не настроен' }, { status: 404 })
  if (!secretOk(req, cfg.webhookSecret)) return NextResponse.json({ error: 'Неверный секрет' }, { status: 401 })
  const u = (await req.json().catch(() => null)) as MaxUpdate | null
  if (!u?.update_type) return NextResponse.json({ ok: true })
  try {
    switch (u.update_type) {
      case 'bot_started': {
        const userId = uid(u.user)
        const v = await checkLink(u.payload ?? null)
        if (!userId) break
        if (v?.kind === 'max' && (await linkMax(v.id, userId))) {
          await audit('max.linked', null, { patientId: v.id })
          await sendMaxMessage(userId, `Готово! Теперь напоминания о записях в «${clinicBrand()}» будут приходить сюда. Чтобы отказаться от рекламы, напишите «СТОП».`)
        } else {
          // без валидного приглашения пациента не опознать: по имени/номеру MAX привязывать нельзя
          await sendMaxMessage(userId, 'Чтобы получать напоминания, откройте ссылку-приглашение, которую прислала клиника (SMS или регистратура).')
        }
        break
      }
      case 'bot_stopped':
      case 'dialog_removed': {
        const userId = uid(u.user)
        if (userId && (await unlinkMax(userId)) > 0) await audit('max.unlinked', null, { reason: u.update_type })
        break
      }
      case 'message_created': {
        const userId = uid(u.message?.sender)
        const text = (u.message?.body?.text || '').trim().toLowerCase()
        if (!userId || !STOP_WORDS.includes(text)) break
        const p = await db.patient.findUnique({ where: { maxUserId: userId }, select: { id: true } })
        if (p && (await unsubscribeMarketing(p.id, 'MAX'))) await audit('patient.marketing_unsubscribed', null, { patientId: p.id, via: 'max' })
        await sendMaxMessage(userId, 'Вы отписаны от рекламных сообщений. Напоминания о записях продолжат приходить; чтобы отключить и их, остановите бота.')
        break
      }
      case 'message_callback': {
        const cb = u.callback
        const userId = uid(cb?.user)
        const m = /^(ok|no):(.+)$/.exec(cb?.payload || '')
        const v = m ? await checkLink(m[2]) : null
        if (!cb?.callback_id || !userId || !v || (v.kind !== 'ap' && v.kind !== 'wl')) break
        // кнопку может нажать только привязанный к этой записи пациент
        const patient = await db.patient.findUnique({ where: { maxUserId: userId }, select: { id: true } })
        const ownerId =
          v.kind === 'ap'
            ? (await db.appointment.findUnique({ where: { id: v.id }, select: { patientId: true } }))?.patientId
            : (await db.waitingListEntry.findUnique({ where: { id: v.id }, select: { patientId: true } }))?.patientId
        if (!patient || patient.id !== ownerId) {
          await answerMaxCallback(cb.callback_id, 'Эта кнопка больше не действует.')
          break
        }
        const action = v.kind === 'ap' ? (m![1] === 'ok' ? 'confirm' : 'cancel') : m![1] === 'ok' ? 'book' : 'decline'
        const r = await performPatientAction(v.kind, v.id, action, 'MAX')
        if (r.auditAction) await audit(r.auditAction, null, { kind: v.kind, id: v.id, via: 'max' })
        await answerMaxCallback(cb.callback_id, r.message)
        break
      }
    }
  } catch (e) {
    console.error('[max webhook]', (e as Error).message)
  }
  return NextResponse.json({ ok: true })
}
