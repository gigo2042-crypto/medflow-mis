-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "fallbackFrom" TEXT,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "maxLinkedAt" TIMESTAMP(3),
ADD COLUMN     "maxUserId" TEXT;

-- Дубли (ручная отправка поверх плановой) — ссылку оставляем только у последнего сообщения
UPDATE "Notification" n SET "relatedReminderId" = NULL
WHERE n."relatedReminderId" IS NOT NULL AND EXISTS (
  SELECT 1 FROM "Notification" m
  WHERE m."relatedReminderId" = n."relatedReminderId" AND (m."createdAt", m."id") > (n."createdAt", n."id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_relatedReminderId_key" ON "Notification"("relatedReminderId");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_maxUserId_key" ON "Patient"("maxUserId");


-- WhatsApp заменён мессенджером MAX: перенос значений канала в существующих данных
UPDATE "Reminder" SET "channel" = 'MAX' WHERE "channel" = 'WHATSAPP';
UPDATE "Notification" SET "channel" = 'MAX' WHERE "channel" = 'WHATSAPP';
UPDATE "Campaign" SET "channel" = 'MAX' WHERE "channel" = 'WHATSAPP';
-- Неподключённые каналы (Telegram, push) никогда не доставлялись — переводим на SMS
UPDATE "Reminder" SET "channel" = 'SMS' WHERE "channel" IN ('TELEGRAM', 'PUSH');
UPDATE "Campaign" SET "channel" = 'SMS' WHERE "channel" IN ('TELEGRAM', 'PUSH');
