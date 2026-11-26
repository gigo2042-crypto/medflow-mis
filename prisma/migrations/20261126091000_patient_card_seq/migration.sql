-- Нумерация карт пациентов (чек-лист P1): одна реализация на последовательности вместо выгрузки
-- всех номеров карт на каждую запись. Только добавление; стартует с текущего максимума MF-NNNN.
CREATE SEQUENCE IF NOT EXISTS "patient_card_seq" MINVALUE 1 START WITH 1001;
SELECT setval('patient_card_seq', GREATEST(1000, COALESCE((
  SELECT MAX(CAST(SUBSTRING("cardNumber" FROM 4) AS BIGINT)) FROM "Patient" WHERE "cardNumber" ~ '^MF-[0-9]+$'
), 1000)), true);
