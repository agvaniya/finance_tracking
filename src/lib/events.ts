import { prisma } from "./db";
import {
  adjustmentIndex,
  amountForOccurrence,
  autoPayDateInMonth,
  occurrenceKey,
  scheduleOccurrences,
} from "./domain";
import { formatCents } from "./money";
import { toISODate, type Forecast } from "./predictions";

export type CalendarEventType =
  | "card-update"
  | "checking-update"
  | "payment"
  | "paid-off"
  | "autopay"
  | "payday"
  | "bill";

export interface CalendarEvent {
  dateISO: string;
  type: CalendarEventType;
  label: string;
  detail: string;
  colorSlot: number | null; // null = checking account
  severity: "ok" | "tight" | "overdraft";
}

/**
 * Points of interest for one calendar month: recorded balance updates,
 * payments, payoff moments, plus upcoming auto-pay dates (with severity
 * taken from the forecast when it projects a tight or negative balance).
 */
export async function getMonthEvents(
  userId: string,
  year: number,
  monthIndex: number,
  forecast: Forecast,
  now = new Date()
): Promise<CalendarEvent[]> {
  const from = new Date(year, monthIndex, 1);
  const to = new Date(year, monthIndex + 1, 1);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [cardUpdates, payments, checkingUpdates, cards] = await Promise.all([
    prisma.cardBalanceUpdate.findMany({
      where: { recordedAt: { gte: from, lt: to }, kind: "SNAPSHOT", card: { userId } },
      include: { card: true },
    }),
    prisma.cardPayment.findMany({
      where: { paidAt: { gte: from, lt: to }, card: { userId } },
      include: { card: true },
    }),
    prisma.checkingBalanceUpdate.findMany({
      where: { recordedAt: { gte: from, lt: to }, account: { userId } },
      include: { account: true },
    }),
    prisma.creditCard.findMany({ where: { archivedAt: null, userId } }),
  ]);

  const events: CalendarEvent[] = [];

  for (const u of cardUpdates) {
    events.push({
      dateISO: toISODate(u.recordedAt),
      type: "card-update",
      label: `${u.card.name} balance updated`,
      detail: `${formatCents(u.totalBalance)}${u.reason ? ` — ${u.reason}` : ""}`,
      colorSlot: u.card.colorSlot,
      severity: "ok",
    });
  }

  // Paid-off moments: a payment-derived update that brought the total to zero.
  const payoffUpdates = await prisma.cardBalanceUpdate.findMany({
    where: { recordedAt: { gte: from, lt: to }, kind: "PAYMENT", totalBalance: 0, card: { userId } },
    include: { card: true },
  });
  for (const u of payoffUpdates) {
    events.push({
      dateISO: toISODate(u.recordedAt),
      type: "paid-off",
      label: `${u.card.name} paid off`,
      detail: "Balance reached $0.00",
      colorSlot: u.card.colorSlot,
      severity: "ok",
    });
  }

  for (const p of payments) {
    events.push({
      dateISO: toISODate(p.paidAt),
      type: "payment",
      label: `Payment to ${p.card.name}`,
      detail: `${formatCents(p.amount)}${p.note ? ` — ${p.note}` : ""}`,
      colorSlot: p.card.colorSlot,
      severity: "ok",
    });
  }

  for (const u of checkingUpdates) {
    events.push({
      dateISO: toISODate(u.recordedAt),
      type: "checking-update",
      label: `${u.account.name} updated`,
      detail: `${formatCents(u.balance)}${u.reason ? ` — ${u.reason}` : ""}`,
      colorSlot: null,
      severity: "ok",
    });
  }

  // Upcoming auto-pay dates in this month (past ones already appear as payments).
  for (const card of cards) {
    if (card.autoPayDay == null || card.autoPayType === "NONE") continue;
    const date = autoPayDateInMonth(card.autoPayDay, year, monthIndex);
    if (date < today) continue;
    const dateISO = toISODate(date);
    const projected = forecast.autoPays.find((a) => a.cardId === card.id && a.dateISO === dateISO);
    events.push({
      dateISO,
      type: "autopay",
      label: `${card.name} auto pay`,
      detail: projected
        ? `${formatCents(projected.amount)} scheduled${
            projected.severity === "overdraft"
              ? " — would overdraw checking"
              : projected.severity === "tight"
                ? " — leaves checking below the buffer"
                : ""
          }`
        : "Scheduled",
      colorSlot: card.colorSlot,
      severity: projected?.severity ?? "ok",
    });
  }

  // Scheduled paydays still ahead of us this month.
  const incomes = await prisma.recurringIncome.findMany({
    where: { active: true, account: { userId } },
  });
  const monthEnd = new Date(year, monthIndex + 1, 0);
  for (const income of incomes) {
    for (const date of scheduleOccurrences(income, today > from ? today : from, monthEnd)) {
      events.push({
        dateISO: toISODate(date),
        type: "payday",
        label: income.name,
        detail: `${formatCents(income.amount)} expected`,
        colorSlot: null,
        severity: "ok",
      });
    }
  }

  // Scheduled bills still ahead of us this month, at their corrected amount
  // where the real figure has been entered.
  const expenses = await prisma.recurringExpense.findMany({
    where: { active: true, account: { userId } },
  });
  if (expenses.length > 0) {
    const adjustments = adjustmentIndex(
      await prisma.expenseAdjustment.findMany({
        where: { dueDate: { gte: from, lt: to }, expense: { account: { userId } } },
      })
    );
    for (const expense of expenses) {
      for (const date of scheduleOccurrences(expense, today > from ? today : from, monthEnd)) {
        const amount = amountForOccurrence(expense, date, adjustments);
        if (amount <= 0) continue;
        const corrected = adjustments.has(occurrenceKey(expense.id, date));
        events.push({
          dateISO: toISODate(date),
          type: "bill",
          label: expense.name,
          detail: `${formatCents(amount)} due${
            corrected ? " (actual)" : expense.estimated ? " (estimated)" : ""
          }`,
          colorSlot: null,
          severity: "ok",
        });
      }
    }
  }

  events.sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  return events;
}
