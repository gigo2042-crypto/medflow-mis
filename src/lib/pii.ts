// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Поиск и замена персональных данных в свободном тексте (152-ФЗ).
// Общая основа для псевдонимизации перед ИИ (ai-protocol.ts) и для обезличивания
// пациента (consent.ts → anonymizePatient). Правила консервативные: лучше закрыть
// лишнее слово, чем оставить фамилию. Это эвристика, а не NER — см. README_DEPLOY, раздел ИИ.

const L = '\\p{L}'
const NB = `(?<![${L}])` // слева не буква
const NA = `(?![${L}])` // справа не буква

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Падежные окончания имён, фамилий и отчеств (длинные — раньше коротких)
const ENDINGS = [
  'ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ою', 'ею', 'ой', 'ей', 'ом', 'ем', 'ым', 'им',
  'ую', 'юю', 'ая', 'яя', 'ый', 'ий', 'ых', 'их', 'ах', 'ях', 'а', 'я', 'у', 'ю', 'е', 'ы', 'и', 'о', 'ь', 'й',
]
const SUFFIX_RE = `(?:${ENDINGS.join('|')})?`
const SURNAME_TAILS = ['ова', 'ева', 'ёва', 'ина', 'ына', 'ов', 'ев', 'ёв', 'ин', 'ын', 'ская', 'цкая', 'ский', 'цкий', 'ской', 'цкой']

/** ё и е в имени взаимозаменяемы (Пётр/Петр) */
function yoRe(s: string): string {
  return escapeRe(s).replace(/[её]/giu, (c) => (c === c.toUpperCase() ? '[ЕЁ]' : '[её]'))
}

/** Основа слова для поиска падежных форм: «Иванову» → «Иванов», «Иванова» → «Иванов», «Мария» → «Мари». */
export function nameStem(word: string): string[] {
  const w = word.trim()
  if (w.length < 3) return [w]
  const lower = w.toLowerCase()
  const stems = new Set<string>([w])
  // фамилии на -ов/-ев/-ин/-ский: держим основу целиком, чтобы «Иванов» не превратился в «Иван»
  const tail = SURNAME_TAILS.find((t) => lower.endsWith(t) && w.length - t.length >= 2)
  if (tail) {
    const base = w.slice(0, w.length - tail.length)
    const masc = tail.replace(/ая$/, 'ий').replace(/ой$/, 'ий').replace(/а$/, '')
    stems.add(base + masc)
  } else {
    for (const e of ENDINGS) {
      if (lower.endsWith(e) && w.length - e.length >= 3) {
        stems.add(w.slice(0, w.length - e.length))
        break
      }
    }
  }
  // беглая гласная: Павел → Павл(а), Пётр → Петр(а) уже покрыто ё/е
  const m = w.match(/^(.*[^аеёиоуыэюя])[еоё]([^аеёиоуыэюяйь])$/iu)
  if (m && m[1].length >= 2) stems.add(m[1] + m[2])
  return [...stems]
}

/** Регулярное выражение на все падежные формы переданных имён (каждое слово отдельно). */
export function namesRegex(names: Array<string | null | undefined>): RegExp | null {
  const parts = new Set<string>()
  for (const n of names) {
    for (const word of String(n || '').split(/[\s,]+/)) {
      const w = word.replace(/[^\p{L}ё-]/gu, '')
      if (w.length < 2 || w === '—') continue
      if (w.length < 3) {
        parts.add(yoRe(w))
        continue
      }
      for (const s of nameStem(w)) parts.add(yoRe(s))
    }
  }
  if (!parts.size) return null
  const alt = [...parts].sort((a, b) => b.length - a.length).join('|')
  // для фамилий на -ов/-ин допускаем окончания -а/-у/-ым/-ой/-ой и т.п.; ов/ев/ин внутри основы
  return new RegExp(`${NB}(?:${alt})(?:ов|ев|ин)?${SUFFIX_RE}(?:а|у|ым|ой|ою|ых|е|ы|ом)?${NA}`, 'giu')
}

/** Цифры телефона (последние 10) с любыми разделителями между ними; префикс +7/8/7 необязателен. */
export function phoneRegex(phones: Array<string | null | undefined>): RegExp | null {
  const alts = new Set<string>()
  for (const p of phones) {
    const d = String(p || '').replace(/\D/g, '')
    if (d.length < 10) continue
    const ten = d.slice(-10)
    alts.add(ten.split('').join('[\\s().-]*'))
  }
  if (!alts.size) return null
  return new RegExp(`(?:(?:\\+?7|8)[\\s().-]*)?(?:${[...alts].join('|')})(?!\\d)`, 'g')
}

const KIN = [
  'мать', 'матери', 'мамы', 'мама', 'маме', 'отец', 'отца', 'отцу', 'папа', 'папы', 'муж', 'мужа', 'мужу', 'жена', 'жены', 'жене',
  'сын', 'сына', 'сыну', 'дочь', 'дочери', 'дочка', 'брат', 'брата', 'сестра', 'сестры', 'бабушка', 'бабушки', 'дедушка', 'дедушки',
  'супруг', 'супруга', 'супруги', 'ребёнок', 'ребенок', 'внук', 'внука', 'внучка', 'внучки', 'тётя', 'тетя', 'дядя', 'родственник',
  'родственница', 'родственника', 'опекун', 'опекуна', 'представитель', 'представителя',
]
const CAP = '\\p{Lu}[\\p{Ll}ё]+(?:-\\p{Lu}?[\\p{Ll}ё]+)*'
const INIT = '(?<![\\p{L}])\\p{Lu}\\.'
// без флага i: иначе \\p{Lu} совпадает со строчными («ребёнок ходит»)
const KIN_ALT = KIN.map((k) => `[${k[0]}${k[0].toUpperCase()}]${k.slice(1)}`).join('|')
const KIN_RE = new RegExp(`${NB}(${KIN_ALT})${NA}(\\s*[:,—–-]?\\s*)((?:${CAP}|${INIT})(?:\\s*(?:${CAP}|${INIT})){0,2})`, 'gu')
// ФИО с отчеством: «Сидоров Пётр Иванович», «Петра Ивановича», «Мария Петровна»
const PATRONYMIC_RE = new RegExp(`(?:${CAP}\\s+){0,2}\\p{Lu}[\\p{Ll}ё]+(?:ович|евич|ьич|ич|овн|евн|ичн|иничн)[\\p{Ll}]{0,3}${NA}(?:\\s+${CAP}(?:ов|ев|ин|ын|ск|цк)[\\p{Ll}]{0,4}${NA})?`, 'gu')
// Инициалы: «Иванов И.И.», «И. И. Иванов», «Иванов И.»
const INITIALS_RE = new RegExp(`${NB}${CAP}\\s+${INIT}\\s?(?:${INIT})?|${INIT}\\s?(?:${INIT}\\s?)?${CAP}`, 'gu')
// Адреса: улица/проспект/… + название, дом/кв./корп. + номер, город
const STREET = '(?:ул\\.|улица|улице|улицу|пр-т|просп\\.|проспект|проспекте|пер\\.|переулок|переулке|ш\\.|шоссе|б-р|бульвар|бульваре|наб\\.|набережная|набережной|пл\\.|площадь|площади|мкр\\.?|микрорайон|микрорайоне|пос\\.|посёлок|поселок|посёлке|поселке|с\\.|село|селе|дер\\.|деревня|деревне|г\\.|город|городе)'
const ADDRESS_RE = new RegExp(`${NB}${STREET}\\s*(?:${CAP}|\\d+[-\\p{L}]*)(?:[\\s-]+(?:${CAP}|\\d+[-\\p{L}]*))*`, 'gu')
const HOUSE_RE = new RegExp(`${NB}(?:д\\.|дом|кв\\.|квартира|корп\\.|корпус|стр\\.|строение|под\\.|подъезд|эт\\.)\\s*№?\\s*\\d+[\\p{L}/-]*`, 'giu')
const INDEX_RE = /(?<!\d)[1-6]\d{5}(?!\d)(?=\s*,)/g
// Организации: ООО «…», ГБУЗ «…», АО Ромашка, школа № 5
const ORG_FORM = '(?:ООО|ОАО|ЗАО|ПАО|НАО|АО|ИП|ГБУЗ|ГАУЗ|ГБУ|ГКУ|ГУП|ФГУП|ФГБУ|МУП|МБУ|МАУ|МБОУ|МАОУ|ГБОУ|НКО|АНО|ТОО|ЧУ|ЧОУ)'
const ORG_RE = new RegExp(`${NB}${ORG_FORM}${NA}\\s*(?:«[^»\\n]{1,80}»|"[^"\\n]{1,80}"|“[^”\\n]{1,80}”|${CAP}(?:[\\s-]+${CAP}){0,3})`, 'gu')
const ORG_NUM_RE = /(?<![\p{L}])(?:школ[аеуы]|гимнази[яиюей]|лице[йяюе]|детск(?:ий|ом|ого) сад(?:у|е|а)?|д\/с|больниц[аеуы]|поликлиник[аеуи]|роддом[ае]?|завод[ае]?|фабрик[аеуи]|колледж[ае]?|в\/ч|воинск(?:ая|ой) част[ьи])\s*№\s*\d+/giu
const QUOTED_ORG_RE = /(?<![\p{L}])(?:в|на|из|работает в|работает на|учится в)\s+«[^»\n]{1,80}»/giu

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g
const PHONE_RE = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g
const CARD_RE = /\bMF-\d+\b/gi
const SNILS_RE = /\b\d{3}-\d{3}-\d{3}[\s-]?\d{2}\b/g
const PASSPORT_RE = /\b\d{2}\s?\d{2}\s?\d{6}\b/g
const POLICY_RE = /\b\d{16}\b/g

export interface ScrubOptions {
  /** ФИО пациента (любые части), будут закрыты во всех падежах */
  names?: Array<string | null | undefined>
  /** Телефоны пациента в любом формате */
  phones?: Array<string | null | undefined>
  /** E-mail пациента */
  emails?: Array<string | null | undefined>
  /** Подстановка вместо ФИО пациента */
  patientLabel?: string
}

/** Убирает из свободного текста ФИО (в падежах), родственников, адреса, организации, телефоны, e-mail и номера документов. */
export function scrubPd(text: string, o: ScrubOptions = {}): string {
  let out = String(text || '')
  if (!out) return out
  const label = o.patientLabel ?? '[пациент]'
  for (const e of o.emails ?? []) {
    const v = String(e || '').trim()
    if (v) out = out.replace(new RegExp(escapeRe(v), 'gi'), '[email]')
  }
  const ph = phoneRegex(o.phones ?? [])
  if (ph) out = out.replace(ph, '[телефон]')
  out = out.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[телефон]')
  out = out.replace(KIN_RE, (_m, kin, sep) => `${kin}${sep}[родственник]`)
  const nr = namesRegex(o.names ?? [])
  if (nr) out = out.replace(nr, label)
  out = out
    .replace(PATRONYMIC_RE, '[ФИО]')
    .replace(INITIALS_RE, '[ФИО]')
    .replace(ORG_RE, '[организация]')
    .replace(ORG_NUM_RE, '[организация]')
    .replace(QUOTED_ORG_RE, (m) => m.replace(/«[^»]*»/, '[организация]'))
    .replace(INDEX_RE, '[индекс]')
    .replace(ADDRESS_RE, '[адрес]')
    .replace(HOUSE_RE, '[адрес]')
    .replace(CARD_RE, '[карта]')
    .replace(SNILS_RE, '[снилс]')
    .replace(POLICY_RE, '[полис]')
    .replace(PASSPORT_RE, '[документ]')
  return out
}

/** Есть ли в тексте ФИО/телефон пациента (для проверок после обезличивания). */
export function containsPatientPd(text: string, o: ScrubOptions): boolean {
  const nr = namesRegex(o.names ?? [])
  const ph = phoneRegex(o.phones ?? [])
  const s = String(text || '')
  return Boolean((nr && nr.test(s)) || (ph && ph.test(s)))
}
