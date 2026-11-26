# Образ сервиса резервного копирования: pg_dump/pg_restore той же мажорной версии, что и БД,
# openssl — шифрование AES-256, aws-cli — необязательная выгрузка в S3-совместимое хранилище
# (Yandex Object Storage, Selectel S3 и т.п.).
FROM postgres:17-alpine
RUN apk add --no-cache openssl aws-cli coreutils curl
COPY deploy/backup.sh deploy/restore.sh deploy/backup-verify.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh /usr/local/bin/backup-verify.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/backup.sh"]
