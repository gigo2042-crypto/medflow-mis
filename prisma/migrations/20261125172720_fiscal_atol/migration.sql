-- DropIndex
DROP INDEX "Patient_lastName_idx";

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "fiscalError" TEXT,
ADD COLUMN     "fiscalReceiptUrl" TEXT,
ADD COLUMN     "fiscalUuid" TEXT;
