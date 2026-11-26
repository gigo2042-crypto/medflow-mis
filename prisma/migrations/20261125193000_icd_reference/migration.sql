-- CreateTable
CREATE TABLE "IcdCode" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentCode" TEXT,
    "actual" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'NSI_CSV',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IcdCode_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "IcdCode_name_idx" ON "IcdCode"("name");

