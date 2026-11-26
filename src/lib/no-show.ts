// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Предиктивный скор риска неявки — v2-часть ТУ-004 (Zero no-show).
// Модель на признаках из ТЗ: история no-show пациента, источник записи,
// канал и результат подтверждения, длительность до визита, тип услуги,
// день недели и время. Каждый признак даёт вклад (объяснимость) —
// панель «риски на сегодня» показывает факторы и сценарий обработки.
// Серверный модуль — не импортировать в клиентский код!
import { zonedParts } from './mis-utils'

export interface RiskFactorInput {
  label: string
  impact: number // вклад в скор: +повышает риск, − снижает
}

export interface ScoreInput {
  start: Date
  now: Date
  source: string // REGISTRAR | WIDGET | PHONE
  appointmentStatus: string // BOOKED | CONFIRMED | ARRIVED
  specialty: string
  pastNoShows: number // прошлые неявки пациента
  pastAppointments: number // всего прошлых приёмов пациента
  visitsCount: number // завершённых визитов (лояльность)
  reminderSent: number // отправленных напоминаний по приёму
  reminderConfirmed: number // ответов «1»
  reminderDeclined: number // ответов «2» (приём ещё активен — редкий случай)
}

export interface Scenario {
  action: string
  hint: string
}

export interface NoShowScore {
  score: number
  label: string
  riskClass: string
  factors: RiskFactorInput[]
  scenario: Scenario
}

const SPECIALTY_WEIGHTS: Array<{ match: string; weight: number; label: string }> = [
  { match: 'Ортопед', weight: 9, label: 'плановая дорогостоящая услуга' },
  { match: 'Хирург', weight: 5, label: 'хирургия: откладываемый спрос' },
  { match: 'Педиатр', weight: -5, label: 'детский приём: приводят ребёнка' },
  { match: 'Терапевт', weight: -4, label: 'терапия: острые состояния' },
]

// Скор 0..100. Пороги панели: >=50 высокий, 30–49 средний, <30 низкий.
export function scoreNoShow(input: ScoreInput): NoShowScore {
  const factors: RiskFactorInput[] = []
  const add = (label: string, impact: number) => {
    if (impact !== 0) factors.push({ label, impact })
  }

  // 1. История no-show пациента (ТУ-004)
  const noShowShare = input.pastAppointments > 0 ? input.pastNoShows / input.pastAppointments : 0
  if (input.pastNoShows > 0) {
    add(`было неявок: ${input.pastNoShows}`, Math.min(45, input.pastNoShows * 18))
    if (noShowShare >= 0.3) add(`доля неявок ${(noShowShare * 100).toFixed(0)}%`, 8)
  }

  // 2. Источник записи (ТУ-004)
  if (input.source === 'PHONE') add('запись по звонку — без подтверждения онлайн', 14)
  else if (input.source === 'WIDGET') add('запись из виджета — подтверждена онлайн', -7)
  else add('запись через регистратуру', 4)

  // 3. Канал и результат подтверждения (ТУ-004)
  if (input.appointmentStatus === 'CONFIRMED') add('приём подтверждён пациентом', -18)
  if (input.reminderConfirmed > 0) add(`ответ «1» на напоминание`, -12)
  else if (input.reminderSent > 0) add(`напоминаний отправлено: ${input.reminderSent}, ответа нет`, 12)
  if (input.reminderDeclined > 0) add('был ответ «2» без отмены записи', 15)

  // 4. Длительность до визита (ТУ-004)
  const hoursUntil = (input.start.getTime() - input.now.getTime()) / 3600_000
  if (hoursUntil > 14 * 24) add(`до визита ${(hoursUntil / 24).toFixed(0)} дн. — забываемость`, 14)
  else if (hoursUntil > 7 * 24) add(`до визита ${(hoursUntil / 24).toFixed(0)} дн.`, 8)
  else if (hoursUntil > 3 * 24) add(`до визита ${(hoursUntil / 24).toFixed(0)} дн.`, 4)
  else if (hoursUntil < 3) add(`до визита ${Math.max(0, hoursUntil).toFixed(1)} ч — «горячий» слот`, -8)

  // 5. День недели и время (ТУ-004)
  // день недели и час — в поясе клиники (0 = ВС, как раньше)
  const zp = zonedParts(input.start)
  const day = (zp.weekday + 1) % 7
  const hour = zp.hour
  if (day === 1 && hour < 10) add('понедельник до 10:00 — пик неявок', 6)
  if (day === 5 && hour >= 16) add('пятница вечером — пик неявок', 8)
  if (day === 0 || day === 6) add('выходной день', 4)

  // 6. Тип услуги (ТУ-004)
  for (const s of SPECIALTY_WEIGHTS) {
    if (input.specialty.includes(s.match)) {
      add(`направление «${input.specialty}»: ${s.label}`, s.weight)
      break
    }
  }

  // 7. Лояльность пациента
  if (input.visitsCount >= 5) add(`визитов в анамнезе: ${input.visitsCount}`, -8)
  else if (input.visitsCount === 0 && input.pastAppointments === 0) add('новый пациент — без истории', 10)

  let score = 12 + factors.reduce((s, f) => s + f.impact, 0)
  score = Math.max(5, Math.min(96, Math.round(score)))

  const label = score >= 50 ? 'Высокий' : score >= 30 ? 'Средний' : 'Низкий'
  const riskClass = score >= 50 ? 'bg-rose-100 text-rose-700' : score >= 30 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
  const scenario =
    score >= 50
      ? {
          action: 'Позвонить сейчас + SMS-касание',
          hint: 'Высокий риск: зафиксировать звонок, отправить срочное касание и заранее подобрать замену из листа ожидания',
        }
      : score >= 30
        ? {
            action: 'Касание через центр уведомлений',
            hint: 'Средний риск: доп. напоминание за 2–3 часа до приёма через Центр уведомлений (ФТ-013)',
          }
        : {
            action: 'Стандартный каскад 48/24/3 ч',
            hint: 'Низкий риск: достаточно регулярного каскада напоминаний (ФТ-005)',
          }

  return { score, label, riskClass, factors: factors.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)), scenario }
}
