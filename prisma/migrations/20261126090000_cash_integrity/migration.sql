-- Касса (чек-лист P0, 54-ФЗ). Только добавления — существующие данные не меняются.

-- Идемпотентность: одна действующая оплата на приём (два одновременных POST → одна оплата).
-- Отменённая/возвращённая оплата (status CANCELED) не мешает принять оплату заново.
CREATE UNIQUE INDEX "Payment_active_visit_payment_key" ON "Payment"("visitId")
  WHERE "type" = 'PAYMENT' AND "status" = 'PAID' AND "visitId" IS NOT NULL;

-- Ключ идемпотентности от клиента (повтор запроса из того же окна оплаты не создаёт вторую оплату)
ALTER TABLE "Payment" ADD COLUMN "clientKey" TEXT;
CREATE UNIQUE INDEX "Payment_clientKey_key" ON "Payment"("clientKey");

-- Скидка сверх лимита роли — по одноразовому подтверждению администратора
ALTER TABLE "Payment" ADD COLUMN "discountApprovalId" TEXT;

CREATE TABLE "DiscountApproval" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "maxDiscount" INTEGER NOT NULL,
    "reason" TEXT,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedById" TEXT,
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscountApproval_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DiscountApproval_code_key" ON "DiscountApproval"("code");
CREATE INDEX "DiscountApproval_patientId_idx" ON "DiscountApproval"("patientId");
