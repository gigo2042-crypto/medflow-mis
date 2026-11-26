#!/bin/sh
# Алерт по /api/health: запускать раз в минуту (cron/systemd-timer) на хосте или в отдельном контейнере.
#   HEALTH_URL         — что проверять (по умолчанию http://127.0.0.1:3000/api/health; за Caddy — https://домен/api/health)
#   HEALTH_ALERT_URL   — вызывается (GET), когда проверка провалилась HEALTH_FAILS_BEFORE_ALERT раз подряд (по умолчанию 3)
#   HEALTH_OK_URL      — вызывается при каждой успешной проверке (dead man's switch: healthchecks.io self-hosted, Uptime Kuma push)
#   HEALTH_STATE_DIR   — где хранить счётчик неудач (по умолчанию /tmp/medflow-health)
# Алерт отправляется один раз на серию неудач; после восстановления — HEALTH_ALERT_URL?recovered=1.
# Код возврата: 0 — здорово, 1 — нет.
set -u
URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
N="${HEALTH_FAILS_BEFORE_ALERT:-3}"
S="${HEALTH_STATE_DIR:-/tmp/medflow-health}"
mkdir -p "$S"; f="$S/fails"; a="$S/alerted"
fails="$(cat "$f" 2>/dev/null || echo 0)"
call() { [ -n "$1" ] && curl -fsS -m 10 --retry 2 -o /dev/null "$1" 2>/dev/null; return 0; }
body="$(curl -fsS -m 10 "$URL" 2>/dev/null)"
if [ $? -eq 0 ] && printf '%s' "$body" | grep -q '"ok":true'; then
  echo 0 > "$f"
  if [ -f "$a" ]; then rm -f "$a"; [ -n "${HEALTH_ALERT_URL:-}" ] && call "${HEALTH_ALERT_URL}$(case "$HEALTH_ALERT_URL" in *\?*) echo '&';; *) echo '?';; esac)recovered=1"; fi
  call "${HEALTH_OK_URL:-}"
  exit 0
fi
fails=$((fails + 1)); echo "$fails" > "$f"
echo "[health] $(date -Iseconds) проверка не прошла ($fails подряд): $URL" >&2
if [ "$fails" -ge "$N" ] && [ ! -f "$a" ]; then touch "$a"; call "${HEALTH_ALERT_URL:-}"; fi
exit 1
