-- CreateTable
CREATE TABLE "CreditCard" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT,
    "lastFour" TEXT,
    "creditLimit" INTEGER NOT NULL,
    "autoPayDay" INTEGER,
    "autoPayType" TEXT NOT NULL DEFAULT 'STATEMENT',
    "autoPayFixedAmount" INTEGER,
    "minimumPayment" INTEGER NOT NULL DEFAULT 3500,
    "colorSlot" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardBalanceUpdate" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "totalBalance" INTEGER NOT NULL,
    "statementBalance" INTEGER NOT NULL,
    "reason" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'SNAPSHOT',
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardBalanceUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardPayment" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckingAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Checking account',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckingBalanceUpdate" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL,
    "reason" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckingBalanceUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditCard_archivedAt_idx" ON "CreditCard"("archivedAt");

-- CreateIndex
CREATE INDEX "CardBalanceUpdate_cardId_recordedAt_idx" ON "CardBalanceUpdate"("cardId", "recordedAt");

-- CreateIndex
CREATE INDEX "CardPayment_cardId_paidAt_idx" ON "CardPayment"("cardId", "paidAt");

-- CreateIndex
CREATE INDEX "CheckingBalanceUpdate_accountId_recordedAt_idx" ON "CheckingBalanceUpdate"("accountId", "recordedAt");

-- AddForeignKey
ALTER TABLE "CardBalanceUpdate" ADD CONSTRAINT "CardBalanceUpdate_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "CreditCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardPayment" ADD CONSTRAINT "CardPayment_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "CreditCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckingBalanceUpdate" ADD CONSTRAINT "CheckingBalanceUpdate_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CheckingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
