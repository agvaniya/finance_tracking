-- CreateTable
CREATE TABLE "RecurringIncome" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "frequency" TEXT NOT NULL,
    "dayOfMonth" INTEGER,
    "secondDayOfMonth" INTEGER,
    "anchorDate" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringIncome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringIncome_accountId_active_idx" ON "RecurringIncome"("accountId", "active");

-- AddForeignKey
ALTER TABLE "RecurringIncome" ADD CONSTRAINT "RecurringIncome_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CheckingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
