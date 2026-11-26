#!/bin/sh
# Проверка deploy/monitor/health-alert.sh на локальных фейковых серверах (без внешних вызовов).
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; W="$(mktemp -d)"; trap 'pkill -P $$ 2>/dev/null; rm -rf "$W"' EXIT
ok() { echo "  ✓ $1"; }; fail() { echo "  ✗ $1" >&2; exit 1; }
port() { node -e 's=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})'; }
HP=$(port); AP=$(port)
# «приложение»: ответ берётся из файла $W/health (ok/fail)
node -e 'const fs=require("fs");require("http").createServer((q,r)=>{const ok=fs.readFileSync(process.argv[1],"utf8").trim()==="ok";r.writeHead(ok?200:503,{"content-type":"application/json"});r.end(JSON.stringify({ok}))}).listen(+process.argv[2])' "$W/health" "$HP" & APP_PID=$!
# приёмник алертов: пишет пути запросов
node -e 'require("http").createServer((q,r)=>{require("fs").appendFileSync(process.argv[1],q.url+"\n");r.end("ok")}).listen(+process.argv[2])' "$W/calls" "$AP" &
sleep 0.5; : > "$W/calls"
export HEALTH_URL="http://127.0.0.1:$HP/api/health" HEALTH_ALERT_URL="http://127.0.0.1:$AP/alert" HEALTH_OK_URL="http://127.0.0.1:$AP/ok" HEALTH_STATE_DIR="$W/state"
echo ok > "$W/health"; sh "$ROOT/deploy/monitor/health-alert.sh" && grep -qx /ok "$W/calls" && ok "здорово → код 0 и пинг HEALTH_OK_URL" || fail "успешная проверка"
echo fail > "$W/health"; : > "$W/calls"
for i in 1 2; do sh "$ROOT/deploy/monitor/health-alert.sh" 2>/dev/null && fail "503 принят за здоровье" || true; done
[ ! -s "$W/calls" ] && ok "2 неудачи подряд — алерта ещё нет (порог 3)" || fail "алерт раньше порога"
sh "$ROOT/deploy/monitor/health-alert.sh" 2>/dev/null || true; sh "$ROOT/deploy/monitor/health-alert.sh" 2>/dev/null || true
[ "$(grep -c '^/alert$' "$W/calls")" = 1 ] && ok "3-я неудача → один алерт, повторов нет" || fail "алерт: $(cat "$W/calls")"
kill "$APP_PID"; sleep 0.3
sh "$ROOT/deploy/monitor/health-alert.sh" 2>/dev/null && fail "недоступное приложение принято за здоровье" || ok "приложение не отвечает → код 1"
node -e 'const fs=require("fs");require("http").createServer((q,r)=>{const ok=fs.readFileSync(process.argv[1],"utf8").trim()==="ok";r.writeHead(ok?200:503);r.end(JSON.stringify({ok}))}).listen(+process.argv[2])' "$W/health" "$HP" &
sleep 0.5; echo ok > "$W/health"; : > "$W/calls"
sh "$ROOT/deploy/monitor/health-alert.sh" && grep -qx '/alert?recovered=1' "$W/calls" && ok "восстановление → уведомление recovered=1" || fail "нет уведомления о восстановлении: $(cat "$W/calls")"
echo "Алерт по /api/health: все проверки пройдены"
