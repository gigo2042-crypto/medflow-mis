-- Роль приложения без прав владельца (чек-лист P1 «Аудит неизменяемый на уровне БД»).
-- Миграции выполняет владелец схемы (DATABASE_URL_MIGRATE / ручной `prisma migrate deploy`),
-- МИС работает под ролью medflow_app: не может отключить триггер, изменить или удалить AuditLog.
-- Запуск (владельцем БД, после миграций; пароль задаётся отдельно, в файл не пишется):
--   psql "$OWNER_URL" -v app_role=medflow_app -f deploy/postgres/app-role.sql
--   psql "$OWNER_URL" -c "ALTER ROLE medflow_app PASSWORD '…'"
-- После каждой новой миграции скрипт можно запускать повторно (идемпотентен).
\set ON_ERROR_STOP on
SELECT format('CREATE ROLE %I LOGIN', :'app_role')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec

SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', :'app_role') \gexec
-- Журнал аудита: только чтение и добавление
SELECT format('REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM %I', :'app_role') \gexec
-- Служебная таблица миграций — только чтение
SELECT format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "_prisma_migrations" FROM %I', :'app_role') \gexec
