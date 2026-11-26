#!/bin/sh
# Резервное копирование БД МИС: pg_dump (custom-формат) → шифрование AES-256 (openssl, PBKDF2)
# → ./backups и, если задано, S3-совместимое хранилище. Незашифрованные бэкапы не создаются.
#
# Переменные:
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE — подключение к БД
#   BACKUP_PASSPHRASE_FILE   — файл с ключевой фразой (рекомендуется; docker secret / chmod 600)
#   BACKUP_PASSPHRASE        — или сама фраза (хуже: видна в окружении контейнера)
#   BACKUP_DIR               — каталог (по умолчанию /backups)
#   BACKUP_AT                — ЧЧ:ММ ежедневного запуска (по TZ контейнера), по умолчанию 03:30
#   BACKUP_KEEP_DAYS         — хранение локальных копий, дней (по умолчанию 14)
#   BACKUP_S3_BUCKET         — s3://бакет/префикс — копия ВНЕ сервера, обязательна; ключи — AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
#   BACKUP_ALLOW_LOCAL_ONLY  — 1: осознанно без внешней копии (пусконаладка); иначе бэкап без S3 = ошибка
#   BACKUP_S3_ENDPOINT       — https://storage.yandexcloud.net и т.п. (для не-AWS хранилищ)
#   BACKUP_VERIFY            — 1 (по умолчанию): после каждого бэкапа пробное восстановление во временную БД
#   BACKUP_HEALTHCHECK_URL   — URL, который «пингуется» после успешного бэкапа и проверки (healthchecks.io,
#                              Uptime Kuma push и т.п.: внешний сервис поднимет тревогу, если пинга не было)
#   BACKUP_ALERT_URL         — URL, который вызывается при ошибке (необязательно)
#   Итог последнего запуска пишется в $BACKUP_DIR/STATUS (OK|FAIL время).
# Запуск: backup.sh        — демон (ежедневно в BACKUP_AT)
#         backup.sh now    — один бэкап сейчас (код возврата ≠ 0 при ошибке)
set -eu
umask 077
DIR="${BACKUP_DIR:-/backups}"
BACKUP_AT="${BACKUP_AT:-03:30}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
ITER=200000

# Ключевая фраза хранится отдельно от бэкапов: файл ключа внутри каталога бэкапов — ошибка
# (иначе копия каталога = данные + ключ). Копию ключа держите вне сервера и вне бакета S3.
key_separate() {
  [ -n "${BACKUP_PASSPHRASE_FILE:-}" ] || return 0
  kdir="$(cd "$(dirname "$BACKUP_PASSPHRASE_FILE")" 2>/dev/null && pwd -P)" || return 0
  bdir="$(mkdir -p "$DIR" && cd "$DIR" && pwd -P)"
  case "$kdir/" in
    "$bdir"/*) echo "[backup] ключевая фраза лежит в каталоге бэкапов ($DIR) — храните ключ отдельно" >&2; return 1 ;;
  esac
  return 0
}

# Копия вне сервера обязательна (чек-лист P1): без неё пожар/шифровальщик/потеря диска = потеря данных
offhost() {
  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then return 0; fi
  if [ "${BACKUP_ALLOW_LOCAL_ONLY:-}" = "1" ]; then
    echo "[backup] ВНИМАНИЕ: копия только локальная (BACKUP_ALLOW_LOCAL_ONLY=1) — задайте BACKUP_S3_BUCKET" >&2
    return 0
  fi
  echo "[backup] не задан BACKUP_S3_BUCKET: копия вне сервера обязательна (осознанный отказ — BACKUP_ALLOW_LOCAL_ONLY=1)" >&2
  return 1
}

passfile() {
  if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
    [ -r "$BACKUP_PASSPHRASE_FILE" ] || { echo "[backup] нет доступа к BACKUP_PASSPHRASE_FILE" >&2; return 1; }
    echo "$BACKUP_PASSPHRASE_FILE"
  elif [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    f="$(mktemp)"; chmod 600 "$f"; printf '%s' "$BACKUP_PASSPHRASE" > "$f"; echo "$f"
  else
    echo "[backup] не задан BACKUP_PASSPHRASE_FILE (или BACKUP_PASSPHRASE): незашифрованные бэкапы ПДн не делаем" >&2
    return 1
  fi
}

dump() {
  mkdir -p "$DIR"
  offhost || return 1
  key_separate || return 1
  pf="$(passfile)" || return 1
  name="medflow-$(date +%Y%m%d-%H%M%S).dump.enc"
  tmp="$DIR/.$name.tmp"
  # pipefail нет в POSIX sh — статус pg_dump проверяем через файл-флаг
  rc_file="$(mktemp)"
  { pg_dump --no-owner --format=custom --compress=6 || echo fail > "$rc_file"; } \
    | openssl enc -aes-256-cbc -salt -pbkdf2 -iter "$ITER" -pass "file:$pf" > "$tmp" || echo fail > "$rc_file"
  [ "$pf" != "${BACKUP_PASSPHRASE_FILE:-}" ] && rm -f "$pf"
  if [ -s "$rc_file" ] || [ ! -s "$tmp" ]; then
    rm -f "$tmp" "$rc_file"; echo "[backup] ОШИБКА pg_dump/шифрования" >&2; return 1
  fi
  rm -f "$rc_file"
  mv "$tmp" "$DIR/$name"
  (cd "$DIR" && sha256sum "$name" > "$name.sha256")
  echo "[backup] OK $DIR/$name ($(wc -c < "$DIR/$name") байт)"
  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    ep=""; [ -n "${BACKUP_S3_ENDPOINT:-}" ] && ep="--endpoint-url $BACKUP_S3_ENDPOINT"
    # shellcheck disable=SC2086
    if aws $ep s3 cp "$DIR/$name" "${BACKUP_S3_BUCKET%/}/$name" --only-show-errors \
      && aws $ep s3 cp "$DIR/$name.sha256" "${BACKUP_S3_BUCKET%/}/$name.sha256" --only-show-errors; then
      echo "[backup] S3 OK ${BACKUP_S3_BUCKET%/}/$name"
    else
      echo "[backup] ОШИБКА выгрузки в S3 (локальная копия сохранена)" >&2; return 1
    fi
  fi
  find "$DIR" -maxdepth 1 \( -name 'medflow-*.dump.enc' -o -name 'medflow-*.dump.enc.sha256' \) -mtime "+$KEEP" -delete
}

ping() { [ -n "$1" ] && { curl -fsS -m 15 --retry 3 -o /dev/null "$1" || echo "[backup] не удалось вызвать $2-URL" >&2; }; return 0; }

run_once() {
  if dump && { [ "${BACKUP_VERIFY:-1}" != "1" ] || BACKUP_DIR="$DIR" sh "$(dirname "$0")/backup-verify.sh" >/dev/null; }; then
    echo "OK $(date -Iseconds)" > "$DIR/STATUS"; ping "${BACKUP_HEALTHCHECK_URL:-}" healthcheck; return 0
  fi
  mkdir -p "$DIR"; echo "FAIL $(date -Iseconds)" > "$DIR/STATUS"
  echo "[backup] ОШИБКА: бэкап или проверка восстановления не прошли" >&2
  ping "${BACKUP_ALERT_URL:-}" alert; return 1
}

if [ "${1:-}" = "now" ]; then run_once; exit $?; fi
pf0="$(passfile)" || exit 1
[ "$pf0" != "${BACKUP_PASSPHRASE_FILE:-}" ] && rm -f "$pf0"
offhost || exit 1
key_separate || exit 1
echo "[backup] ежедневно в $BACKUP_AT, хранение $KEEP дн.${BACKUP_S3_BUCKET:+, копия в S3}"
last=""
while true; do
  now="$(date +%H:%M)"; day="$(date +%F)"
  if [ "$now" = "$BACKUP_AT" ] && [ "$last" != "$day" ]; then run_once || true; last="$day"; fi
  sleep 30
done
