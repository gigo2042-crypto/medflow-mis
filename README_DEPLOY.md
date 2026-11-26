# MedFlow: развёртывание

В репозитории один код и два режима работы: `APP_MODE=production` и `APP_MODE=demo`.

| | Production | Демо-стенд |
|---|---|---|
| Сборка | `docker build .`: каталоги `src/app/api/demo`, `src/demo`, демо-сид и моки **удаляются из образа** | `--build-arg APP_MODE=demo` |
| Данные | пустая БД, справочники, первый администратор создаётся через CLI | вымышленные пациенты, сброс раз в сутки и кнопкой в баннере |
| Вход | пароль + TOTP (обязателен для ролей из `TWO_FA_ROLES`), SSO по OIDC | код 2FA выводится на экран, учебный SSO |
| SMS / e-mail / ИИ | SMS.ru / SMTP / YandexGPT, GigaChat, OpenAI-совместимый API (по умолчанию всё выключено) | никаких внешних отправок: SMS-заглушка, мок-почта, ИИ по шаблону |
| Файл compose | `docker-compose.yml` | `compose.demo.yml` |

Защита от запуска демо в production:
- в production-образе нет демо-кода;
- `src/proxy.ts` отвечает 404 на `/api/demo/*`, если режим не demo;
- каждый демо-маршрут дополнительно проверяет `demoOnly()`;
- переменная `MEDFLOW_BUILD=production` запрещает задать `APP_MODE=demo` в production-образе.

Без обязательных секретов приложение **не стартует**: `scripts/check-env.mjs` проверяет окружение при запуске контейнера, `instrumentation.ts` при старте сервера. Ошибки выводятся по-русски.

---

## 1. Свой сервер: всё на одной машине

Состав: app (Next.js standalone), postgres 17, caddy (HTTPS от Let's Encrypt), scheduler (фоновые задачи), backup (ежедневный зашифрованный `pg_dump` с пробным восстановлением).

**Что нужно заранее:**
- Linux с Docker 24+ и Compose v2.20+;
- 2 vCPU, 4 ГБ RAM, 40 ГБ SSD;
- DNS-запись `mis.example.ru` → IP сервера;
- открытые порты 80 и 443.

```bash
# 1. Код
tar xzf medflow-prod-*.tar.gz && cd medflow-prod

# 2. Конфигурация
cp .env.example .env
# Задайте APP_URL, MEDFLOW_DOMAIN, ACME_EMAIL, CLINIC_TZ.
# Секреты сгенерируйте и впишите в .env:
#   SESSION_SECRET — openssl rand -hex 32
#   SERVICE_KEY — openssl rand -hex 24
#   LINK_SECRET — openssl rand -hex 32 (подпись ссылок пациента в SMS/MAX; НЕ равен SESSION_SECRET)
#   POSTGRES_PASSWORD — только буквы и цифры: пароль подставляется в URL
# Оставьте COMPOSE_PROFILES=localdb: Postgres и бэкапы поднимаются в compose.
# Копия бэкапов вне сервера обязательна: BACKUP_S3_BUCKET (+ ключи S3), см. «Бэкапы» ниже.
# Ключ шифрования бэкапов (храните копию ВНЕ сервера и НЕ в бакете бэкапов — без неё бэкап не расшифровать):
mkdir -p secrets && openssl rand -base64 32 > secrets/backup_passphrase && chmod 600 secrets/backup_passphrase
# Реквизиты клиники (обязательны для печати документов и чеков): CLINIC_NAME, CLINIC_INN,
# CLINIC_ADDRESS, CLINIC_LICENSE; желательно CLINIC_SHORT_NAME (в SMS), CLINIC_OGRN, CLINIC_PHONE.

# 3. Сборка и запуск (миграции применяются автоматически сервисом migrate)
docker compose up -d --build
docker compose ps            # app в статусе healthy, migrate — exited (0)

# 4. Справочники (шаблоны протоколов, печатные формы, тексты уведомлений, каскад напоминаний)
docker compose run --rm tools npm run cli -- init-reference

# 5. Первый администратор: пароль и TOTP-секрет выводятся ОДИН раз
docker compose run --rm tools npm run cli -- create-admin --login admin --name "Фамилия Имя"
#   Отсканируйте otpauth-URI в Яндекс Ключе, Google Authenticator или аналоге.

# 6. Врачи и сотрудники
docker compose run --rm tools npm run cli -- create-doctor --name "Иванова Анна Сергеевна" --specialty "Терапевт" --start 09:00 --end 18:00 --slot 30
docker compose run --rm tools npm run cli -- list-doctors
docker compose run --rm tools npm run cli -- create-user --login doc1 --role DOCTOR --name "Иванова А. С." --doctor-id <id>
docker compose run --rm tools npm run cli -- create-user --login reg1 --role REGISTRAR --name "…"

# 7. Справочник МКБ-10 (полный, из НСИ Минздрава: справочник 1.2.643.5.1.13.13.11.1005, выгрузка CSV).
#    Скачайте CSV на nsi.rosminzdrav.ru, положите в каталог проекта и импортируйте (нужно ≥1000 строк, иначе --force):
docker compose run --rm -v "$PWD/mkb10.csv:/app/mkb10.csv:ro" tools npm run cli -- icd-import --file /app/mkb10.csv
#    Без импорта работает только встроенный короткий список кодов.

# 8. Текст согласия на обработку ПДн для онлайн-записи (утверждает юрист/DPO клиники).
#    Без него /book и /api/widget не принимают записи (503).
docker compose run --rm -v "$PWD/soglasie.txt:/app/soglasie.txt:ro" tools npm run cli -- consent-text --file /app/soglasie.txt
#    Название версии в журнале согласий — PD_CONSENT_VERSION (иначе sha256 текста).
```

**График врачей.** По умолчанию у врача рабочие дни Пн–Пт (`workDays=1111100`). Если клиника работает в субботу/воскресенье, поправьте график кнопкой «График» в расписании; там же — праздники клиники, отпуска и особые часы. На нерабочий день запись невозможна ни в регистратуре, ни в виджете.

Услуги и цены прайса администратор заводит в интерфейсе: вкладка «Касса» → прайс.

**Другие команды CLI:**
- `set-password --login X` — новый пароль, все сессии пользователя завершаются;
- `totp-reset --login X` — новый TOTP-секрет;
- `unlock --login X [--ip A.B.C.D]` — снять блокировку входа после неудачных попыток;
- `deactivate --login X [--reason "…"]` / `activate --login X` — отключить сотрудника (сессии завершаются) и вернуть доступ. **Удалять сотрудников нельзя**: журнал аудита неизменяем, а удаление обнулило бы ссылки на сотрудника в журнале — БД откажет;
- `revoke-links --url https://…/r/<токен>` | `--kind ap|wl|u|max --id <id>` | `--patient <id>` `[--reason "…"]` — отозвать ссылки пациента (утечка SMS, смена телефона): отзываются все ссылки этого вида на объект, выпущенные до текущего момента;
- `link-doctor --login X --doctor-id Y`.

**Бэкапы.** Сервис `backup` (образ `deploy/backup.Dockerfile`) ежедневно в `BACKUP_AT` делает `pg_dump`, шифрует его AES-256 (openssl, PBKDF2) ключом из `secrets/backup_passphrase` и кладёт в `./backups/medflow-ГГГГММДД-ЧЧММСС.dump.enc` + `.sha256`. Незашифрованные бэкапы не создаются: без ключа сервис не стартует.
- После каждого бэкапа — пробное восстановление во временную БД (`BACKUP_VERIFY=1`), итог в `./backups/STATUS`.
- Алерты: `BACKUP_HEALTHCHECK_URL` пингуется после успеха (healthchecks.io, Uptime Kuma push — тревога, если пинга нет), `BACKUP_ALERT_URL` вызывается при ошибке.
- Копия вне сервера **обязательна**: `BACKUP_S3_BUCKET=s3://бакет/префикс`, `BACKUP_S3_ENDPOINT` (например, https://storage.yandexcloud.net), `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_REGION`. Без бакета бэкап считается неудачным (`STATUS=FAIL`, `BACKUP_ALERT_URL`). На время пусконаладки можно осознанно разрешить только локальную копию: `BACKUP_ALLOW_LOCAL_ONLY=1` (в журнале будет предупреждение).
- Ключ шифрования хранится отдельно от бэкапов: файл ключа внутри каталога бэкапов — ошибка; в S3 уходят только `.dump.enc` и `.sha256`. Копию ключа держите вне сервера (сейф, менеджер паролей ответственного).
- Хранение локальных копий — `BACKUP_KEEP_DAYS` дней (в S3 срок задайте lifecycle-правилом бакета).
- Внеочередной бэкап: `docker compose exec backup backup.sh now`
- Проверка восстановимости вручную: `docker compose exec backup backup-verify.sh`
- Восстановление (только в ПУСТУЮ БД; файл сверяется по sha256):
  ```bash
  docker compose stop app scheduler
  docker compose exec postgres dropdb -U medflow medflow && docker compose exec postgres createdb -U medflow medflow
  docker compose exec backup restore.sh /backups/medflow-XXXX.dump.enc medflow
  docker compose start app scheduler
  ```
- Скрипты проверены локально без Docker (`tests/backup/roundtrip.sh` на фейковой БД, 19 проверок): шифрование, отказ без ключа, отказ без копии вне сервера, отказ при ключе в каталоге бэкапов, выгрузка в S3 (через подменённый `aws`), восстановление 250/250 строк, журнала аудита и его триггера, индексов. **Не проверено запуском, нет Docker:** сборка образа backup, `docker compose up`, `backup.sh now` и `restore.sh` внутри контейнеров на реальном Postgres в Docker.

**Обновление:**
```bash
tar xzf medflow-prod-NEW.tar.gz
docker compose up -d --build   # migrate применит новые миграции до старта app
```

---

## 2. Облако: Yandex Cloud / Selectel и управляемая БД (152-ФЗ)

Схема: ВМ (или Container Solution) с `app + scheduler + caddy` и внешний **Managed PostgreSQL**. Бэкапы и отказоустойчивость базы берёт на себя облако, поэтому профиль `localdb` не включается.

1. **БД.** Создайте Managed Service for PostgreSQL 16/17 (Yandex Cloud) или «Облачные базы данных» (Selectel):
   - регион РФ;
   - БД `medflow`, пользователь `medflow`;
   - доступ только из подсети ВМ, публичный доступ выключен.
2. **ВМ.** Ubuntu 22.04/24.04 в той же сети (2 vCPU, 4 ГБ), Docker. Группа безопасности: входящие 80/443 из интернета, 22 только с ваших адресов.
3. **`.env`:**
   ```env
   # COMPOSE_PROFILES не задавать
   DATABASE_URL=postgresql://medflow:ПАРОЛЬ@c-xxxx.rw.mdb.yandexcloud.net:6432/medflow?sslmode=require
   ```
   Для Selectel используйте хост и порт из карточки кластера. Остальные переменные задаются так же, как в разделе 1.
4. Запуск: `docker compose up -d --build`, затем шаги 4–6 из раздела 1.
5. Если HTTPS снимает балансировщик облака (L7 ALB с сертификатом из Certificate Manager), уберите сервис `caddy` и направьте балансировщик на порт 3000 сервиса app. Для этого добавьте в `docker-compose.override.yml` проброс `ports: ["3000:3000"]`.
6. **Образы через реестр** (необязательно):
   ```bash
   docker build -t cr.yandex/<registry>/medflow:1.0 --target runner .
   docker build -t cr.yandex/<registry>/medflow-tools:1.0 --target tools .
   ```
   Затем в compose замените `build:` на эти образы.

**152-ФЗ: на что обратить внимание** (решения принимает клиника и её ответственный за ПДн):
- Хранение и обработка ПДн пациентов (медицинские данные — специальная категория) только на территории РФ. Используйте регионы `ru-central1` (YC) или `ru-*` (Selectel) и сервисы, у которых есть аттестат или соответствие требуемому уровню защищённости (обычно УЗ-1/УЗ-2 для медицинских ИСПДн). У обоих провайдеров есть «152-ФЗ-сегменты»; договор и модель угроз оформляются с провайдером.
- Договор поручения обработки ПДн с облачным провайдером, уведомление РКН об обработке ПДн.
- ИИ: при `LLM_PROVIDER` данные псевдонимизируются (ФИО, телефоны, e-mail, номера карт, СНИЛС, полис, паспорт), но всё равно уходят провайдеру. Для ИСПДн выбирайте YandexGPT или GigaChat по договору либо локальную модель внутри контура (`LLM_PROVIDER=openai` + `LLM_BASE_URL` на свой vLLM/Ollama). По умолчанию ИИ выключен.
- SMS.ru и SMTP — тоже обработчики ПДн (телефон, e-mail). Нужен договор и согласие пациента.
- Журнал аудита ведётся (чтение карт, входы, изменения) без ФИО в метаданных. Срок хранения задаётся политикой клиники.

---

## 3. Демо-стенд (для показа)

```bash
cp .env.demo.example .env.demo     # замените CHANGE_ME на любые значения
docker compose -f compose.demo.yml --env-file .env.demo up -d --build
# http://localhost:8080 — стенд, http://127.0.0.1:8025 — мок-почта (логин console)
```

- Наверху баннер «ДЕМО». Администратор видит кнопку «Сбросить демо-данные».
- Ежедневный сброс выполняется в `DEMO_RESET_AT` по времени клиники (сервис scheduler).
- Демо-учётки и пароль показываются на экране входа (`DEMO_PASSWORD`). Учебный SSO: ClinicCorp ID на `:3041`.
- Чтобы показывать по домену: `DEMO_SITE=demo.example.ru`, `DEMO_HTTP_PUBLISH=80`, `DEMO_HTTPS_PUBLISH=443`, `APP_URL=https://demo.example.ru`, затем уберите `ALLOW_INSECURE_HTTP`. IdP публикуйте отдельным поддоменем или оставьте вход по паролю.
- Демо-стенд нельзя поднимать на production-базе: `api/demo/reset` очищает все таблицы.

---

## 4. Настройка интеграций (production)

**SSO (OIDC)**: Keycloak, Яндекс 360, ADFS, Authentik, Azure AD.
- У IdP создайте confidential-клиента с redirect URI ровно `${APP_URL}/api/auth/oidc/callback` и включите PKCE S256.
- Добавьте в id_token claim с группами (в Keycloak — Group Membership mapper, claim `groups`).
- В `.env`:
  - `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`;
  - `OIDC_ROLE_MAP=группа=РОЛЬ,…` (роли ADMIN, HEAD, DOCTOR, REGISTRAR, MARKETER);
  - при необходимости `OIDC_GROUPS_CLAIM`.
- Пользователь без подходящей группы не входит. Роль синхронизируется при каждом входе.
- Для ролей из `OIDC_MFA_ROLES` (по умолчанию ADMIN) IdP должен подтвердить второй фактор (`amr` содержит otp/mfa или `acr` = `OIDC_MFA_ACR`).
- Врача, вошедшего через SSO, привяжите к карточке: `cli link-doctor`.

**TOTP**:
- выдаётся командами `create-admin` / `create-user` (для ролей из `TWO_FA_ROLES`) и `totp-reset`;
- повторное использование кода блокируется;
- после 5 неверных кодов попытка входа сгорает;
- по умолчанию TOTP обязателен для всех ролей с доступом к ПДн (ADMIN, REGISTRAR, DOCTOR, HEAD; `TWO_FA_ROLES`), для SSO — так же (`OIDC_MFA_ROLES` по умолчанию = `TWO_FA_ROLES`);
- лимиты входа хранятся в БД (окно 15 минут): 5 ошибок на пару «логин+IP» (подбор с одного адреса не блокирует сотрудника на других адресах), 30 на IP, 100 на логин глобально; снять — `cli unlock`.

**Мессенджер MAX** (вместо WhatsApp): бот и токен создаются на платформе MAX для партнёров (документация API — dev.max.ru; условия подключения — по правилам платформы).
- В `.env`: `MAX_BOT_TOKEN`, `MAX_BOT_NAME` (имя бота из ссылки max.ru/<имя>), `MAX_WEBHOOK_SECRET` (5–256 символов `[a-zA-Z0-9_-]`, сгенерируйте: `openssl rand -hex 24`). `MAX_API_URL` менять не нужно.
- Подписка на вебхук (APP_URL должен быть https на порту 443): `docker compose run --rm tools npm run max:subscribe` (проверка: `… max:subscribe -- --list`).
- Бот не может написать первым: пациент привязывается, только открыв ссылку-приглашение (кнопка в карточке пациента, SMS-приглашение или экран после онлайн-записи) и нажав «Начать».
- Непривязанным пациентам, при ненастроенном боте или постоянной ошибке MAX сообщения уходят по SMS (в Центре уведомлений видно «MAX → SMS»).

**Служебные оповещения** (склад, недоставленные письма): `STAFF_ALERT_EMAIL`; без него — только журнал Центра уведомлений.

**SMS**: `SMS_PROVIDER=smsru`, `SMSRU_API_ID`, при необходимости `SMSRU_FROM`. `SMSRU_TEST=1` включает тестовый режим SMS.ru без отправки.

**E-mail**: `EMAIL_PROVIDER=smtp`, `SMTP_*`. Отчёты по расписанию уходят только на домены из `REPORT_EMAIL_DOMAINS`.

**Публичный виджет записи**: страница `${APP_URL}/book`; на сайт клиники встраивается так:
```html
<div id="medflow-booking"></div>
<script src="https://<адрес МИС>/embed.js" data-target="medflow-booking" defer></script>
```
- `WIDGET_ALLOWED_ORIGINS="https://clinic.example https://www.clinic.example"` — сайты, которым разрешено встраивание (CSP frame-ancestors); остальные страницы МИС встраивать нельзя.
- Нужны Yandex SmartCaptcha (`SMARTCAPTCHA_CLIENT_KEY`, `SMARTCAPTCHA_SERVER_KEY`), SMS-провайдер (код подтверждения) и утверждённый текст согласия (`cli consent-text`). Без капчи задайте `WIDGET_ENABLED=0` — тогда `/book` и `/api/widget` отвечают 404.
- Согласие на ПДн обязательно (галочка), сохраняется с версией текста, хешем, временем и IP; согласие на рассылки — отдельная необязательная галочка.
- Пациент находится по телефону И фамилии; иначе заводится новая карта (один номер на семью не смешивает медкарты).

**Доступ и прокси**:
- `DOCTOR_SCOPE=own` (по умолчанию) — врач видит только своих пациентов и записи; `all` — всех (решение клиники, зафиксируйте в политике доступа).
- `TRUST_PROXY_HOPS` — сколько обратных прокси перед app (по умолчанию 1 — Caddy/ALB); `0` — заголовки X-Forwarded-For игнорируются.
- Изменяющие запросы к API из браузера принимаются только со своего origin (Host или `APP_URL`).

**ИИ**: `LLM_PROVIDER=yandexgpt|gigachat|openai` с ключами из `.env.example`, по умолчанию `none`.
- Внешний провайдер (YandexGPT, GigaChat, облачный OpenAI-совместимый API) — только с `LLM_EXTERNAL_ALLOWED=1`, иначе production не стартует. Локальная модель (`LLM_PROVIDER=openai` + `LLM_BASE_URL` на localhost/частную сеть/`*.internal`) флага не требует.
- Перед отправкой врач видит **предпросмотр** ровно того текста, что уйдёт модели (ФИО пациента и родственников в любых падежах, телефоны, адреса, документы заменены метками), и подтверждает отправку; запрос с другим текстом сервер отклоняет (хеш). В аудит пишется факт отправки без текста.
Ответ модели проверяется:
- текст на русском;
- все 5 разделов на месте;
- код МКБ только выбранный врачом;
- название диагноза берётся из справочника.

Если проверка не пройдена, используется шаблон.

**Онлайн-касса (54-ФЗ): АТОЛ Онлайн v5, ФФД 1.2.**
- `FISCAL_PROVIDER=atol`, `ATOL_LOGIN`, `ATOL_PASSWORD`, `ATOL_GROUP_CODE`, `ATOL_SNO` (osn | usn_income | usn_income_outcome | esn | patent), `ATOL_PAYMENT_ADDRESS` (сайт/адрес расчётов), `ATOL_COMPANY_EMAIL`, `ATOL_VAT` (по умолчанию none — медуслуги обычно без НДС, уточните у бухгалтера); `CLINIC_INN` обязателен.
- Для теста — тестовая среда АТОЛ: `ATOL_BASE_URL` на тестовый адрес из документации АТОЛ и тестовые реквизиты.
- Без настройки фискализация отвечает 409 «онлайн-касса не подключена», печать чека из МИС закрыта — выдавайте чек с аппаратной ККТ.
- Живые вызовы АТОЛ при проверке не выполнялись: проверено на моках по документации v5.

**ЕГИСЗ/РЭМД, лаборатории, ДМС, телефония, 1С.** Реальных коннекторов нет. В разделе «Интеграции» статус честный: «не подключено» (ЕГИСЗ, лаборатории, ДМС, телефония), «вручную» (1С: XML-выгрузки скачиваются и загружаются в 1С вручную), «настроено» — только для того, что реально настроено в `.env` (SMS, MAX, e-mail, SSO, касса). Симуляторы работают только на демо-стенде.

---

## 5. Безопасность и эксплуатация

**Контейнеры (docker-compose.yml).** Все сервисы: `cap_drop: [ALL]`, `no-new-privileges`, корень ФС только для чтения (`read_only`, запись — tmpfs `/tmp` и тома), лимиты CPU/памяти (`APP_CPUS`, `APP_MEMORY`, `PG_CPUS`, `PG_MEMORY`), ротация логов json-file (5×20 МБ). Исключения по capabilities: caddy — `NET_BIND_SERVICE` (порты 80/443), postgres — `CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID` (entrypoint образа). Caddy ограничивает тело запроса `MEDFLOW_MAX_BODY` (по умолчанию 10MB → 413) и закрывает `/api/metrics` снаружи. `ACME_EMAIL` обязателен.
- Проверено: `docker compose config` (Compose v2.32, без демона) и `caddy validate` (Caddy 2.9) — конфигурации валидны; приложение из production-сборки работает с корнем ФС только для чтения (имитация через bwrap: 47/47 HTTP-тестов).
- **Не проверено запуском, нет Docker:** `docker build`, `docker compose up`, поведение образов postgres/caddy/backup с `read_only` и урезанными capabilities. При первом запуске проверьте `docker compose ps` (все healthy) и `docker compose logs`.

**Журнал аудита неизменяем.** Миграция `audit_immutable` ставит триггеры: `UPDATE`, `DELETE`, `TRUNCATE` таблицы `AuditLog` запрещены всем, включая владельца (снять можно только явным флагом обслуживания внутри одной транзакции — так работает сброс демо). Дополнительно — роль приложения без прав на изменение журнала: `deploy/postgres/app-role.sql` (создаёт `medflow_app`; миграции выполняет владелец через `DATABASE_URL_MIGRATE`, приложение работает под `medflow_app` через `DATABASE_URL`). Следствие: сотрудника с записями в аудите удалить нельзя — используйте `cli deactivate`.

**Ссылки пациента.** Подписываются `LINK_SECRET` (отдельно от сессий). Срок жизни по видам: запись 30 дней, лист ожидания 7, отписка 400, приглашение в MAX 30 (`LINK_TTL_AP_DAYS`, `LINK_TTL_WL_DAYS`, `LINK_TTL_U_DAYS`, `LINK_TTL_MAX_DAYS`). Ротация: новый ключ в `LINK_SECRET`, старый — в `LINK_SECRET_PREVIOUS` на срок жизни ссылок, потом удалить. Отзыв — `cli revoke-links`; при анонимизации пациента его ссылки отзываются автоматически.

**Касса.** Сумма оплаты не больше `PAYMENT_MAX_RUB` (по умолчанию 1 000 000 ₽); скидка выше `DISCOUNT_MAX_PERCENT` (по умолчанию 10 %) — только по одноразовому коду администратора, код действует `DISCOUNT_APPROVAL_TTL_MIN` минут (по умолчанию 30). Повторная отправка формы оплаты не создаёт вторую оплату (ключ идемпотентности + уникальный индекс «одна активная оплата на приём»). Возврат — только по фискализированному чеку; неотправленный чек отменяется (статус «Отменён»).

**Поиск пациентов.** Регистратура не показывает всю картотеку: без запроса — только записанные на ближайшие дни, иначе поиск по ФИО, телефону или № карты; полный список — явным действием, которое пишется в аудит. Права ролей и их настройка без правки кода (`RBAC_OVERRIDES`) — в [docs/ROLES.md](docs/ROLES.md).

**CSP.** На каждую страницу — свой nonce (src/proxy.ts); скрипты исполняются только с ним (`'strict-dynamic'`, без `'unsafe-inline'`), поэтому все страницы рендерятся на запрос. Стили пока допускают `'unsafe-inline'` (атрибуты style у компонентов интерфейса). Вебхук мок-почты `/api/integrations/email/webhook` нужен только демо: в production-образе вырезан, в production-режиме отвечает 404.

**Мониторинг** (внешние аккаунты не нужны):
- **Метрики Prometheus:** `GET /api/metrics` с `Authorization: Bearer <METRICS_TOKEN>`; без токена эндпоинт выключен (404), через Caddy снаружи закрыт — Prometheus в той же docker-сети ходит на `app:3000`. Метрики: `medflow_up`, `medflow_db_up`, `medflow_db_ping_seconds`, память/uptime процесса, `medflow_log_messages_total{level}`, очереди фискализации, интеграций и напоминаний по статусам, активные сессии, неподтверждённые записи из виджета. ПДн в метриках нет. Пример задания:
  ```yaml
  - job_name: medflow
    metrics_path: /api/metrics
    authorization: { credentials_file: /etc/prometheus/medflow_token }
    static_configs: [{ targets: ['app:3000'] }]
  ```
  Полезные алерты: `medflow_db_up == 0`, `medflow_fiscal_payments{status="ERROR"} > 0`, `medflow_integration_events{status="DLQ"} > 0`, рост `medflow_log_messages_total{level="error"}`.
- **Логи:** в production каждая строка — JSON (`ts`, `level`, `svc`, `msg`, `err`); телефоны, e-mail, длинные номера, токены и пароли маскируются перед записью. Сбор: `docker compose logs`, Loki/Promtail, Vector — без парсинга. `LOG_FORMAT=text` — прежний вид. Стартовый баннер Next.js (3–4 строки до запуска приложения) остаётся текстом.
- **Отчёты об ошибках:** выключены по умолчанию. `SENTRY_DSN` — self-hosted GlitchTip/Sentry внутри контура; внешний сервис (sentry.io) только с `SENTRY_EXTERNAL_ALLOWED=1`. Отправляются тип ошибки, очищенный текст и стек — без запросов, cookie и данных пользователя; не больше 30 событий в минуту.
- **Алерт на недоступность `/api/health`:** `deploy/monitor/health-alert.sh` раз в минуту (cron или systemd-timer на хосте):
  ```cron
  * * * * * HEALTH_URL=https://mis.example.ru/api/health HEALTH_ALERT_URL=https://ntfy.example.ru/medflow HEALTH_OK_URL=https://kuma.example.ru/api/push/XXXX /opt/medflow/deploy/monitor/health-alert.sh
  ```
  После 3 неудач подряд (`HEALTH_FAILS_BEFORE_ALERT`) один раз вызывается `HEALTH_ALERT_URL`, после восстановления — с `?recovered=1`; `HEALTH_OK_URL` пингуется при каждой успешной проверке (dead man's switch: если пингов нет — тревожит сам сервис мониторинга, даже если упал весь сервер). Подходят self-hosted ntfy, Uptime Kuma, healthchecks.

---

## 6. Запуск без Docker (для разработки и проверки)

```bash
npm ci
cp .env.example .env    # DATABASE_URL на свой Postgres, ALLOW_INSECURE_HTTP=1, APP_URL=http://localhost:3000
npx prisma migrate deploy
npm run cli -- init-reference && npm run cli -- create-admin --login admin --name "Админ"
npm run build && npm start          # production-сборка (standalone)
npm run scheduler                   # в отдельном терминале
```

**Проверки:**
- `npm run typecheck` — TypeScript;
- `npm test` — модульные тесты;
- `MEDFLOW_BASE_URL=… MEDFLOW_USERS=users.json npm run test:http` — HTTP-тесты по чек-листу;
- `node tests/e2e/chain.mjs` — сквозная цепочка «вход → пациент → запись → перенос → приём → оплата». Роли разделены, как в матрице прав: `E2E_LOGIN`/`E2E_PASSWORD`/`E2E_TOTP_SECRET` — регистратор (пациент, запись, оплата), `E2E_DOCTOR_LOGIN`/`E2E_DOCTOR_PASSWORD`/`E2E_DOCTOR_TOTP_SECRET` — врач (приём). Администратор приём не ведёт (ЭМК у него только на чтение).
