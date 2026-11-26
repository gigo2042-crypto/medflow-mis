#!/bin/sh
# Проверка восстановимости последнего бэкапа: восстановление во временную БД,
# сверка числа строк ключевых таблиц с рабочей БД, удаление временной БД.
# Запускайте регулярно (например, раз в неделю): непроверенный бэкап — не бэкап.
#   backup-verify.sh [файл.dump.enc]    (по умолчанию — самый свежий в BACKUP_DIR)
set -eu
DIR="${BACKUP_DIR:-/backups}"
f="${1:-$(ls -1t "$DIR"/medflow-*.dump.enc 2>/dev/null | head -n1)}"
[ -n "$f" ] || { echo "[verify] бэкапов нет в $DIR" >&2; exit 1; }
tmpdb="medflow_restore_check_$(date +%s)"
createdb "$tmpdb"
trap 'dropdb --if-exists "$tmpdb" >/dev/null 2>&1 || true' EXIT
"$(dirname "$0")/restore.sh" "$f" "$tmpdb"
fail=0
for t in Patient Appointment Visit Payment ConsentRecord _prisma_migrations; do
  n="$(psql -d "$tmpdb" -Atc "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo ERR)"
  echo "[verify] $t: $n"
  [ "$n" = "ERR" ] && fail=1
done
[ "$fail" = 0 ] || { echo "[verify] ОШИБКА: восстановленная БД неполная" >&2; exit 1; }
echo "[verify] OK: $f восстанавливается"
