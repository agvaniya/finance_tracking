-- CreateTable
CREATE TABLE "OneTimeIncome" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "note" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "balanceUpdateId" TEXT,

    CONSTRAINT "OneTimeIncome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OneTimeIncome_balanceUpdateId_key" ON "OneTimeIncome"("balanceUpdateId");

-- CreateIndex
CREATE INDEX "OneTimeIncome_accountId_receivedAt_idx" ON "OneTimeIncome"("accountId", "receivedAt");

-- AddForeignKey
ALTER TABLE "OneTimeIncome" ADD CONSTRAINT "OneTimeIncome_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CheckingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneTimeIncome" ADD CONSTRAINT "OneTimeIncome_balanceUpdateId_fkey" FOREIGN KEY ("balanceUpdateId") REFERENCES "CheckingBalanceUpdate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
