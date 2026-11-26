-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "anonymizedAt" TIMESTAMP(3),
ADD COLUMN     "marketingConsentAt" TIMESTAMP(3),
ADD COLUMN     "pdConsentAt" TIMESTAMP(3),
ADD COLUMN     "pdConsentRevokedAt" TIMESTAMP(3),
ADD COLUMN     "pdConsentSource" TEXT,
ADD COLUMN     "pdConsentVersion" TEXT;

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "version" TEXT,
    "textHash" TEXT,
    "source" TEXT NOT NULL,
    "staffId" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsentRecord_patientId_idx" ON "ConsentRecord"("patientId");

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Поиск пациентов по ФИО без полного сканирования в приложении
CREATE INDEX IF NOT EXISTS "Patient_lastName_idx" ON "Patient" ("lastName");
