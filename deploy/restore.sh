#!/bin/sh
# Восстановление из зашифрованного бэкапа: проверка sha256 → расшифровка → pg_restore.
#   restore.sh <файл.dump.enc> <целевая_БД>
# Целевая БД должна быть ПУСТОЙ (создайте её заранее: createdb …). Восстановление поверх
# рабочей БД этим скриптом не делается — переключите приложение на восстановленную БД
# (DATABASE_URL) после проверки. Подключение — PGHOST PGPORT PGUSER PGPASSWORD;
# ключевая фраза — BACKUP_PASSPHRASE_FILE или BACKUP_PASSPHRASE.
set -eu
src="${1:-}"; target="${2:-}"
[ -n "$src" ] && [ -n "$target" ] || { echo "Использование: restore.sh <файл.dump.enc> <целевая_БД>" >&2; exit 2; }
[ -r "$src" ] || { echo "Нет файла $src" >&2; exit 2; }
if [ -r "$src.sha256" ]; then
  (cd "$(dirname "$src")" && sha256sum -c "$(basename "$src").sha256" >/dev/null) || { echo "[restore] контрольная сумма не совпала" >&2; exit 1; }
  echo "[restore] sha256 OK"
else
  echo "[restore] предупреждение: нет $src.sha256 — целостность не проверена" >&2
fi
tables="$(psql -d "$target" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
[ "$tables" = "0" ] || { echo "[restore] БД $target не пустая ($tables таблиц) — укажите новую пустую БД" >&2; exit 1; }
if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then pf="$BACKUP_PASSPHRASE_FILE"; else
  [ -n "${BACKUP_PASSPHRASE:-}" ] || { echo "Не задан BACKUP_PASSPHRASE_FILE/BACKUP_PASSPHRASE" >&2; exit 2; }
  pf="$(mktemp)"; chmod 600 "$pf"; printf '%s' "$BACKUP_PASSPHRASE" > "$pf"
fi
plain="$(mktemp)"
trap 'rm -f "$plain"; [ "$pf" != "${BACKUP_PASSPHRASE_FILE:-}" ] && rm -f "$pf"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$pf" -in "$src" -out "$plain" || { echo "[restore] не удалось расшифровать (неверная фраза?)" >&2; exit 1; }
pg_restore --no-owner --exit-on-error -d "$target" "$plain"
echo "[restore] OK: $src → $target"
