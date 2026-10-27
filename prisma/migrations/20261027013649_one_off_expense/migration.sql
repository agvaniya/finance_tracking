-- CreateTable
CREATE TABLE "OneOffExpense" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "cardId" TEXT,
    "accountId" TEXT,
    "cardUpdateId" TEXT,
    "checkingUpdateId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OneOffExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OneOffExpense_cardUpdateId_key" ON "OneOffExpense"("cardUpdateId");

-- CreateIndex
CREATE UNIQUE INDEX "OneOffExpense_checkingUpdateId_key" ON "OneOffExpense"("checkingUpdateId");

-- CreateIndex
CREATE INDEX "OneOffExpense_userId_recordedAt_idx" ON "OneOffExpense"("userId", "recordedAt");

-- AddForeignKey
ALTER TABLE "OneOffExpense" ADD CONSTRAINT "OneOffExpense_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneOffExpense" ADD CONSTRAINT "OneOffExpense_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "CreditCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneOffExpense" ADD CONSTRAINT "OneOffExpense_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CheckingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneOffExpense" ADD CONSTRAINT "OneOffExpense_cardUpdateId_fkey" FOREIGN KEY ("cardUpdateId") REFERENCES "CardBalanceUpdate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneOffExpense" ADD CONSTRAINT "OneOffExpense_checkingUpdateId_fkey" FOREIGN KEY ("checkingUpdateId") REFERENCES "CheckingBalanceUpdate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
