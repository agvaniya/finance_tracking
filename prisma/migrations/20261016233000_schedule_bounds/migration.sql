-- AlterTable
ALTER TABLE "RecurringIncome" ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "startDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RecurringExpense" ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "startDate" TIMESTAMP(3);
