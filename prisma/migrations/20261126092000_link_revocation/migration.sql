-- Отзыв подписанных ссылок пациента (чек-лист P1): ссылки вида kind на объект targetId,
-- выпущенные не позже revokedAt, недействительны. Только добавление.
CREATE TABLE "LinkRevocation" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    CONSTRAINT "LinkRevocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LinkRevocation_kind_targetId_key" ON "LinkRevocation"("kind", "targetId");
