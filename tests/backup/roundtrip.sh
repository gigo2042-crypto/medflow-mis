#!/bin/sh
# Проверка резервного копирования на ОДНОРАЗОВОЙ БД с фейковыми данными:
# бэкап шифруется, без ключа не создаётся, восстанавливается (включая частичный индекс),
# неверная фраза / подмена файла / непустая целевая БД — отказ.
#   PGHOST=… PGPORT=… PGUSER=… PGPASSWORD=… sh tests/backup/roundtrip.sh
# Нужны: pg_dump/pg_restore/psql/createdb/dropdb, openssl, sha256sum, npx prisma (миграции).
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="medflow_bk_src_test_$$"; DST="medflow_bk_dst_test_$$"
WORK="$(mktemp -d)"; export BACKUP_DIR="$WORK/backups"
cleanup() { dropdb --if-exists "$SRC" >/dev/null 2>&1 || true; dropdb --if-exists "$DST" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
ok() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1" >&2; exit 1; }

createdb "$SRC"
base="postgresql://$(node -e 'console.log(encodeURIComponent(process.env.PGUSER)+":"+encodeURIComponent(process.env.PGPASSWORD||""))')@${PGHOST:-localhost}:${PGPORT:-5432}"
(cd "$ROOT" && DATABASE_URL="$base/$SRC" npx prisma migrate deploy >/dev/null)
psql -q -d "$SRC" -c "INSERT INTO \"AuditLog\"(id,action) SELECT 'a'||g,'test.event' FROM generate_series(1,30) g"
psql -q -d "$SRC" -c "INSERT INTO \"Patient\"(id,\"cardNumber\",\"lastName\",\"firstName\",phone,\"updatedAt\") SELECT 'p'||g,'T-'||g,'Фейков','Тест'||g,'+7900000'||lpad(g::text,4,'0'),now() FROM generate_series(1,250) g"
export PGDATABASE="$SRC"

(unset BACKUP_PASSPHRASE_FILE BACKUP_PASSPHRASE; sh "$ROOT/deploy/backup.sh" now >/dev/null 2>&1) && fail "бэкап без ключа должен отказать" || ok "без ключевой фразы бэкап не создаётся"

(umask 077; openssl rand -base64 32 > "$WORK/pass")
export BACKUP_PASSPHRASE_FILE="$WORK/pass"
(unset BACKUP_S3_BUCKET BACKUP_ALLOW_LOCAL_ONLY; sh "$ROOT/deploy/backup.sh" now >/dev/null 2>&1) && fail "бэкап без копии вне сервера должен отказать" || ok "без BACKUP_S3_BUCKET (и без явного BACKUP_ALLOW_LOCAL_ONLY=1) — отказ"
mkdir -p "$BACKUP_DIR"; (umask 077; cp "$WORK/pass" "$BACKUP_DIR/key")
(BACKUP_PASSPHRASE_FILE="$BACKUP_DIR/key" BACKUP_ALLOW_LOCAL_ONLY=1 sh "$ROOT/deploy/backup.sh" now >/dev/null 2>&1) && fail "ключ в каталоге бэкапов принят" || ok "ключ в каталоге бэкапов — отказ"
rm -f "$BACKUP_DIR/key"
# «S3» — подмена aws CLI в PATH, копирует в локальный каталог (живых вызовов нет)
mkdir -p "$WORK/bin" "$WORK/s3"
cat > "$WORK/bin/aws" <<SH
#!/bin/sh
while [ "\$1" != "cp" ]; do shift; done; shift
cp "\$1" "$WORK/s3/\$(basename "\$2")"
SH
chmod +x "$WORK/bin/aws"
PATH="$WORK/bin:$PATH" BACKUP_S3_BUCKET="s3://fake-bucket/medflow" sh "$ROOT/deploy/backup.sh" now >/dev/null
s3f="$(ls -1 "$WORK/s3"/medflow-*.dump.enc 2>/dev/null | head -1)"
[ -n "$s3f" ] && [ -f "$s3f.sha256" ] && ok "копия вне сервера: шифрованный файл и sha256 выгружены" || fail "нет выгрузки в S3"
ls "$WORK/s3" | grep -qv -e '\.dump\.enc$' -e '\.dump\.enc\.sha256$' && fail "в S3 ушло лишнее" || ok "в S3 только шифрованный бэкап и sha256 (ключа нет)"
rm -f "$BACKUP_DIR"/medflow-*
export BACKUP_ALLOW_LOCAL_ONLY=1
sh "$ROOT/deploy/backup.sh" now >/dev/null
f="$(ls -1 "$BACKUP_DIR"/medflow-*.dump.enc)"
[ "$(head -c 8 "$f")" = "Salted__" ] && ok "файл зашифрован (openssl, соль)" || fail "файл не зашифрован"
grep -q 'Фейков' "$f" && fail "в бэкапе открытый текст" || ok "открытых данных в файле нет"
[ "$(stat -c %a "$f")" = "600" ] && ok "права 600" || fail "права файла не 600"

createdb "$DST"
printf 'wrong' > "$WORK/wrong"
(BACKUP_PASSPHRASE_FILE="$WORK/wrong" sh "$ROOT/deploy/restore.sh" "$f" "$DST" >/dev/null 2>&1) && fail "неверная фраза принята" || ok "неверная фраза — отказ"
(sh "$ROOT/deploy/restore.sh" "$f" "$SRC" >/dev/null 2>&1) && fail "восстановление в непустую БД" || ok "непустая целевая БД — отказ"
cp "$f" "$WORK/t.dump.enc"; sed "s#$(basename "$f")#t.dump.enc#" "$f.sha256" > "$WORK/t.dump.enc.sha256"
printf 'X' | dd of="$WORK/t.dump.enc" bs=1 seek=500 conv=notrunc 2>/dev/null
(sh "$ROOT/deploy/restore.sh" "$WORK/t.dump.enc" "$DST" >/dev/null 2>&1) && fail "подменённый файл принят" || ok "подмена файла — отказ по sha256"

sh "$ROOT/deploy/restore.sh" "$f" "$DST" >/dev/null
[ "$(psql -d "$DST" -Atc 'SELECT count(*) FROM "Patient"')" = "250" ] && ok "восстановлено 250 из 250 пациентов" || fail "число строк не совпало"
[ "$(psql -d "$DST" -Atc "SELECT count(*) FROM pg_indexes WHERE indexname='Appointment_active_slot_key'")" = "1" ] && ok "частичный индекс слотов восстановлен" || fail "нет частичного индекса"
[ "$(psql -d "$DST" -Atc 'SELECT count(*) FROM "AuditLog"')" = "30" ] && ok "журнал аудита восстановлен (30 из 30)" || fail "журнал аудита не восстановлен"
(psql -d "$DST" -Atc 'DELETE FROM "AuditLog"' >/dev/null 2>&1) && fail "после восстановления журнал аудита изменяем" || ok "триггер неизменяемости аудита восстановлен"
[ "$(psql -d "$DST" -Atc "SELECT count(*) FROM pg_indexes WHERE indexname='Payment_active_visit_payment_key'")" = "1" ] && ok "индекс «одна оплата на приём» восстановлен" || fail "нет индекса оплат"
sh "$ROOT/deploy/backup-verify.sh" >/dev/null && ok "backup-verify.sh: OK" || fail "backup-verify.sh"
grep -q '^OK ' "$BACKUP_DIR/STATUS" && ok "STATUS=OK после бэкапа с проверкой" || fail "нет STATUS=OK"
# ошибка → STATUS=FAIL и вызов BACKUP_ALERT_URL (локальный приёмник на случайном порту)
port=$(node -e 's=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
node -e 'require("http").createServer((q,r)=>{require("fs").writeFileSync(process.argv[1],q.url);r.end("ok");setTimeout(()=>process.exit(0),50)}).listen(+process.argv[2])' "$WORK/alert" "$port" &
sleep 0.5
(PGDATABASE=medflow_no_such_db_$$ BACKUP_ALERT_URL="http://127.0.0.1:$port/fail" sh "$ROOT/deploy/backup.sh" now >/dev/null 2>&1) && fail "бэкап несуществующей БД «успешен»" || true
wait
grep -q '^FAIL ' "$BACKUP_DIR/STATUS" && [ "$(cat "$WORK/alert")" = "/fail" ] && ok "ошибка → STATUS=FAIL и вызван BACKUP_ALERT_URL" || fail "алерт об ошибке не сработал"
echo "Бэкапы: все проверки пройдены"
