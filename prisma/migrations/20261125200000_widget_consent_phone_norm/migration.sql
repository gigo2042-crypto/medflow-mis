-- Согласие на обработку ПДн в черновике записи виджета
ALTER TABLE "WidgetDraft" ADD COLUMN "consentVersion" TEXT,
  ADD COLUMN "consentHash" TEXT,
  ADD COLUMN "consentIp" TEXT,
  ADD COLUMN "marketingConsent" BOOLEAN NOT NULL DEFAULT false;

-- Нормализация телефона (та же логика, что normalizePhone в src/lib/mis-utils.ts):
-- только цифры; 8XXXXXXXXXX → 7XXXXXXXXXX; 9XXXXXXXXX (10 цифр) → 79XXXXXXXXX
CREATE OR REPLACE FUNCTION mf_phone_norm(p text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN d ~ '^8[0-9]{10}$' THEN '7' || substr(d, 2)
    WHEN d ~ '^9[0-9]{9}$' THEN '7' || d
    ELSE d END
  FROM (SELECT regexp_replace(coalesce(p, ''), '\D', '', 'g') AS d) s
$$;

-- Поиск пациента по телефону без загрузки всей картотеки
CREATE INDEX IF NOT EXISTS "Patient_phone_norm_idx" ON "Patient" (mf_phone_norm(phone));

-- Чёрный список: ключ в новом формате; дубликаты (8… и 7… одного номера) схлопываются
DELETE FROM "NotificationBlacklist" b
 USING "NotificationBlacklist" o
 WHERE mf_phone_norm(b.phone) = mf_phone_norm(o.phone) AND b.id <> o.id
   AND (b."createdAt", b.id) > (o."createdAt", o.id);
UPDATE "NotificationBlacklist" SET phone = mf_phone_norm(phone) WHERE phone <> mf_phone_norm(phone);
