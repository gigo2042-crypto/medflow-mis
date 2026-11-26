-- Журнал аудита неизменяем на уровне БД (чек-лист P1): UPDATE, DELETE и TRUNCATE таблицы "AuditLog"
-- отклоняются триггером для любой роли, включая владельца таблицы. Только добавление.
-- Единственное исключение — явное обслуживание в одной транзакции:
--   SELECT set_config('medflow.audit_maintenance', 'on', true);  -- действует до конца транзакции
-- Его используют сброс демо-стенда и тестовая БД; рабочий код МИС журнал не меняет.
-- Полная защита от владельца БД (он может отключить триггер) — отдельная роль приложения без прав
-- владельца: deploy/postgres/app-role.sql (README_DEPLOY, раздел «Аудит»).
CREATE OR REPLACE FUNCTION medflow_audit_immutable() RETURNS trigger AS $$
BEGIN
  IF current_setting('medflow.audit_maintenance', true) = 'on' THEN
    IF TG_OP = 'TRUNCATE' THEN RETURN NULL; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AuditLog неизменяем: % запрещён', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_immutable_row"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION medflow_audit_immutable();

CREATE TRIGGER "AuditLog_immutable_truncate"
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION medflow_audit_immutable();
