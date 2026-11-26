-- Отменённые записи и неявки больше не удаляются и не сдвигаются ради освобождения слота:
-- уникальность (врач, время) действует только для активных записей.
DROP INDEX IF EXISTS "Appointment_doctorId_start_key";
CREATE INDEX "Appointment_doctorId_start_idx" ON "Appointment"("doctorId", "start");
CREATE UNIQUE INDEX "Appointment_active_slot_key" ON "Appointment"("doctorId", "start")
  WHERE "status" NOT IN ('CANCELED', 'NO_SHOW');
