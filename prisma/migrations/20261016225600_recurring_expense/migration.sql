-- CreateTable
CREATE TABLE "RecurringExpense" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "frequency" TEXT NOT NULL,
    "dayOfMonth" INTEGER,
    "secondDayOfMonth" INTEGER,
    "anchorDate" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseAdjustment" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringExpense_accountId_active_idx" ON "RecurringExpense"("accountId", "active");

-- CreateIndex
CREATE INDEX "ExpenseAdjustment_dueDate_idx" ON "ExpenseAdjustment"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseAdjustment_expenseId_dueDate_key" ON "ExpenseAdjustment"("expenseId", "dueDate");

-- AddForeignKey
ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CheckingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseAdjustment" ADD CONSTRAINT "ExpenseAdjustment_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "RecurringExpense"("id") ON DELETE CASCADE ON UPDATE CASCADE;
