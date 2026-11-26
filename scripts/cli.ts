// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Административные команды МИС (production и демо):
//   npm run cli -- create-admin --login admin --name "Иванова Ольга"   первый администратор
//   npm run cli -- set-password --login reg1                            новый случайный пароль
//   npm run cli -- totp-reset --login admin                             выдать новый TOTP-секрет
//   npm run cli -- unlock --login reg1 [--ip 203.0.113.5]               снять блокировку входа после неудачных попыток
//   npm run cli -- deactivate --login reg1 [--reason "уволен"]          отключить сотрудника (удалять нельзя: аудит неизменяем)
//   npm run cli -- activate --login reg1                                вернуть доступ
//   npm run cli -- revoke-links --url https://…/r/<токен> | --kind ap --id <id> | --patient <id>   отозвать ссылки пациента
//   npm run cli -- create-user --login doc1 --name "…" --role DOCTOR [--doctor-id …]
//   npm run cli -- link-doctor --login doc1 --doctor-id <id>            привязать учётку к врачу
//   npm run cli -- list-doctors
//   npm run cli -- init-reference                                       справочники чистой БД
//   npm run cli -- icd-import --file mkb10.csv                          справочник МКБ-10 из выгрузки НСИ (CSV)
//   npm run cli -- consent-text --file soglasie.txt [--version 2026-11]   текст согласия на ПДн для онлайн-записи
//   npm run cli -- create-doctor --name "…" --specialty "Терапевт" [--start 09:00 --end 18:00 --slot 30]
// Пароли генерируются и печатаются ОДИН раз; в БД — только scrypt-хэш.
import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { hashPassword, passwordProblem } from '../src/lib/password'
import { generateTotpSecret, otpauthUri } from '../src/lib/totp'
import { seedReference } from '../src/reference/seed-reference'
import { twoFaRoles } from '../src/lib/auth/twofa-policy'
import { readFileSync } from 'fs'
import { parseIcdCsv } from '../src/lib/icd-import'
import { verifyLink } from '../src/lib/patient-links'

const ROLES = ['ADMIN', 'REGISTRAR', 'DOCTOR', 'MARKETER', 'HEAD']

function args(): { cmd: string; opts: Record<string, string> } {
  const [cmd = 'help', ...rest] = process.argv.slice(2)
  const opts: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      opts[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true'
    }
  }
  return { cmd, opts }
}

function genPassword(): string {
  // 18 символов base64url + гарантированная цифра
  return `${randomBytes(14).toString('base64url')}7`
}

function need(opts: Record<string, string>, key: string): string {
  const v = opts[key]
  if (!v || v === 'true') {
    console.error(`Не указан --${key}`)
    process.exit(2)
  }
  return v
}

function printTotp(secret: string, login: string) {
  console.log('\nTOTP (Google Authenticator, Яндекс Ключ и т.п.) — добавьте один из вариантов:')
  console.log(`  секрет: ${secret}`)
  console.log(`  URI:    ${otpauthUri(secret, login, process.env.TOTP_ISSUER || 'MedFlow')}`)
}

async function main() {
  const { cmd, opts } = args()
  const db = new PrismaClient()
  try {
    if (cmd === 'create-admin' || cmd === 'create-user') {
      const login = need(opts, 'login').toLowerCase()
      const name = need(opts, 'name')
      const role = cmd === 'create-admin' ? 'ADMIN' : need(opts, 'role').toUpperCase()
      if (!ROLES.includes(role)) throw new Error(`Роль должна быть одной из: ${ROLES.join(', ')}`)
      if (await db.staffUser.findUnique({ where: { login } })) throw new Error(`Логин ${login} уже занят`)
      const password = opts.password && opts.password !== 'true' ? opts.password : genPassword()
      const problem = passwordProblem(password)
      if (problem) throw new Error(problem)
      // TOTP сразу для ролей, которым вход без второго фактора запрещён (TWO_FA_ROLES)
      const withTotp = role === 'ADMIN' || twoFaRoles().includes(role) || opts.totp === 'true'
      const secret = withTotp ? generateTotpSecret() : null
      const doctorId = opts['doctor-id'] && opts['doctor-id'] !== 'true' ? opts['doctor-id'] : null
      if (doctorId && !(await db.doctor.findUnique({ where: { id: doctorId } }))) throw new Error('Врач с таким id не найден')
      await db.staffUser.create({
        data: { login, name, role, passwordHash: await hashPassword(password), totpSecret: secret, totpEnabled: Boolean(secret), doctorId, email: opts.email ?? null },
      })
      console.log(`Создан пользователь ${login} (${role}).`)
      if (!opts.password) console.log(`Пароль (показывается один раз): ${password}`)
      if (secret) printTotp(secret, login)
      return
    }
    if (cmd === 'set-password') {
      const login = need(opts, 'login').toLowerCase()
      const password = genPassword()
      await db.staffUser.update({ where: { login }, data: { passwordHash: await hashPassword(password) } })
      await db.authSession.deleteMany({ where: { user: { login } } })
      console.log(`Новый пароль ${login} (показывается один раз): ${password}\nВсе сессии пользователя завершены.`)
      return
    }
    if (cmd === 'totp-reset') {
      const login = need(opts, 'login').toLowerCase()
      const secret = generateTotpSecret()
      await db.staffUser.update({ where: { login }, data: { totpSecret: secret, totpEnabled: true } })
      await db.authSession.deleteMany({ where: { user: { login } } })
      console.log(`TOTP для ${login} перевыпущен, сессии завершены.`)
      printTotp(secret, login)
      return
    }
    if (cmd === 'deactivate' || cmd === 'activate') {
      // Сотрудника не удаляют: записи журнала аудита ссылаются на него, а журнал неизменяем (триггер БД).
      const login = need(opts, 'login').toLowerCase()
      const active = cmd === 'activate'
      const u = await db.staffUser.findUnique({ where: { login }, select: { id: true } })
      if (!u) throw new Error(`Пользователь ${login} не найден`)
      await db.$transaction([
        db.staffUser.update({ where: { id: u.id }, data: { active } }),
        ...(active ? [] : [db.authSession.deleteMany({ where: { userId: u.id } })]),
        db.auditLog.create({ data: { action: active ? 'user.activated' : 'user.deactivated', meta: JSON.stringify({ targetUserId: u.id, via: 'cli', reason: opts.reason && opts.reason !== 'true' ? opts.reason.slice(0, 200) : undefined }) } }),
      ])
      console.log(active ? `${login}: доступ восстановлен` : `${login}: отключён, все сессии завершены`)
      return
    }
    if (cmd === 'unlock') {
      // Блокировки входа: login:user:<логин>|<ip>, login:acct:<логин>, login:ip:<ip>
      const login = opts.login && opts.login !== 'true' ? opts.login.toLowerCase() : null
      const ip = opts.ip && opts.ip !== 'true' ? opts.ip : null
      if (!login && !ip) throw new Error('Укажите --login и/или --ip')
      const where = [
        ...(login ? [{ key: { startsWith: `login:user:${login}|` } }, { key: `login:acct:${login}` }] : []),
        ...(ip ? [{ key: `login:ip:${ip}` }, { key: `2fa:ip:${ip}` }] : []),
      ]
      const r = await db.rateLimit.deleteMany({ where: login && ip ? { OR: [{ key: `login:user:${login}|${ip}` }, ...where.slice(1)] } : { OR: where } })
      console.log(`Снято блокировок: ${r.count}`)
      return
    }
    if (cmd === 'revoke-links') {
      // Отзыв подписанных ссылок (утечка SMS, смена телефона, жалоба пациента). Отзываются все ссылки
      // этого вида на объект, выпущенные до текущего момента; новые (новые напоминания) работают.
      const reason = opts.reason && opts.reason !== 'true' ? opts.reason.slice(0, 200) : 'cli'
      const targets: Array<{ kind: string; id: string }> = []
      if (opts.url || opts.token) {
        const raw = String(opts.url || opts.token).trim()
        const token = raw.includes('/r/') ? raw.split('/r/').pop()!.split(/[?#]/)[0] : raw
        const v = verifyLink(token)
        if (!v) throw new Error('Ссылка не распознана (подпись/срок) — отзывать нечего или укажите --kind и --id')
        targets.push({ kind: v.kind, id: v.id })
      } else if (opts.patient) {
        const patientId = opts.patient
        targets.push({ kind: 'u', id: patientId }, { kind: 'max', id: patientId })
        for (const a of await db.appointment.findMany({ where: { patientId }, select: { id: true } })) targets.push({ kind: 'ap', id: a.id })
        for (const w of await db.waitingListEntry.findMany({ where: { patientId }, select: { id: true } })) targets.push({ kind: 'wl', id: w.id })
      } else {
        const kind = need(opts, 'kind')
        if (!['ap', 'wl', 'u', 'max'].includes(kind)) throw new Error('--kind: ap | wl | u | max')
        targets.push({ kind, id: need(opts, 'id') })
      }
      const revokedAt = new Date(Date.now() + 60_000)
      for (const t of targets) {
        await db.linkRevocation.upsert({ where: { kind_targetId: { kind: t.kind, targetId: t.id } }, create: { kind: t.kind, targetId: t.id, revokedAt, reason }, update: { revokedAt, reason } })
      }
      await db.auditLog.create({ data: { action: 'links.revoked', meta: JSON.stringify({ count: targets.length, kinds: [...new Set(targets.map((t) => t.kind))], via: 'cli' }) } })
      console.log(`Отозвано ссылок (вид+объект): ${targets.length}`)
      return
    }
    if (cmd === 'link-doctor') {
      const login = need(opts, 'login').toLowerCase()
      const doctorId = need(opts, 'doctor-id')
      await db.staffUser.update({ where: { login }, data: { doctorId } })
      console.log(`Учётная запись ${login} привязана к врачу ${doctorId}.`)
      return
    }
    if (cmd === 'consent-text') {
      // Текст согласия утверждает клиника (юрист/DPO); без него онлайн-запись в production не принимается
      const body = readFileSync(need(opts, 'file'), 'utf8').replace(/\r\n/g, '\n').trim()
      if (body.length < 200) throw new Error('Текст согласия слишком короткий (меньше 200 символов) — проверьте файл')
      await db.documentTemplate.upsert({
        where: { code: 'PD_CONSENT_WIDGET' },
        update: { body, active: true, kind: 'CONSENT' },
        create: { code: 'PD_CONSENT_WIDGET', name: 'Согласие на обработку ПДн (онлайн-запись)', kind: 'CONSENT', body, active: true },
      })
      const { createHash } = await import('crypto')
      const hash = createHash('sha256').update(body, 'utf8').digest('hex')
      console.log(`Текст согласия сохранён (${body.length} символов, sha256:${hash.slice(0, 12)}). Версия в записях согласий: ${process.env.PD_CONSENT_VERSION || `sha256:${hash.slice(0, 12)}`}`)
      if (opts.version) console.log(`Чтобы версия называлась «${opts.version}», задайте PD_CONSENT_VERSION=${opts.version} в .env и перезапустите app.`)
      return
    }
    if (cmd === 'init-reference') {
      console.log('Справочники:', await seedReference(db))
      return
    }
    if (cmd === 'create-doctor') {
      const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
      const workStart = opts.start ?? '09:00'
      const workEnd = opts.end ?? '18:00'
      const slotMinutes = Number(opts.slot ?? 30)
      if (!HHMM.test(workStart) || !HHMM.test(workEnd) || workStart >= workEnd) throw new Error('Часы приёма в формате ЧЧ:ММ, начало раньше конца')
      if (![10, 15, 20, 30, 40, 45, 60, 90].includes(slotMinutes)) throw new Error('Длительность слота: 10, 15, 20, 30, 40, 45, 60 или 90 минут')
      const d = await db.doctor.create({ data: { name: need(opts, 'name'), specialty: need(opts, 'specialty'), workStart, workEnd, slotMinutes } })
      console.log(`Врач создан: ${d.id}  ${d.name}`)
      return
    }
    if (cmd === 'icd-import') {
      // Выгрузка справочника 1.2.643.5.1.13.13.11.1005 с nsi.rosminzdrav.ru (CSV, UTF-8).
      // Повторный импорт обновляет названия и признак актуальности; коды, которых нет в файле,
      // помечаются неактуальными (не удаляются — на них ссылаются старые визиты).
      const file = need(opts, 'file')
      const { rows, skipped } = parseIcdCsv(readFileSync(file, 'utf8'))
      if (rows.length < 1000 && opts.force !== 'true') throw new Error(`В файле всего ${rows.length} кодов — похоже на неполную выгрузку (полный справочник ~15 тыс.). Для принудительной загрузки добавьте --force`)
      let n = 0
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500)
        await db.$transaction(chunk.map((r) => db.icdCode.upsert({
          where: { code: r.code },
          create: { code: r.code, name: r.name, parentCode: r.parentCode, actual: r.actual, source: 'NSI_CSV' },
          update: { name: r.name, parentCode: r.parentCode, actual: r.actual, source: 'NSI_CSV' },
        })))
        n += chunk.length
      }
      const stale = await db.icdCode.updateMany({ where: { code: { notIn: rows.map((r) => r.code) }, actual: true }, data: { actual: false } })
      console.log(`МКБ-10: загружено/обновлено ${n}, пропущено строк ${skipped}, помечено неактуальными ${stale.count}`)
      return
    }
    if (cmd === 'list-doctors') {
      const docs = await db.doctor.findMany({ orderBy: { name: 'asc' }, include: { staffUser: { select: { login: true } } } })
      for (const d of docs) console.log(`${d.id}  ${d.name} · ${d.specialty}${d.staffUser ? ` · учётка ${d.staffUser.login}` : ''}`)
      return
    }
    console.log('Команды: init-reference, icd-import, consent-text, create-admin, create-user, create-doctor, set-password, totp-reset, link-doctor, list-doctors (см. шапку scripts/cli.ts)')
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => {
  console.error('Ошибка:', (e as Error).message)
  process.exit(1)
})
