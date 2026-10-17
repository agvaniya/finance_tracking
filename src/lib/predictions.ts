import type {
  CreditCard,
  ExpenseAdjustment,
  RecurringExpense,
  RecurringIncome,
} from "@prisma/client";
import {
  adjustmentIndex,
  amountForOccurrence,
  autoPayAmount,
  autoPayDateInMonth,
  occurrenceKey,
  scheduleOccurrences,
} from "./domain";
import type { CardWithState } from "./queries";

/**
 * History-based forecast of the checking account.
 *
 * Method: the net daily drift of the checking balance is estimated from the
 * recorded history (last balance minus the balance ~90 days ago, divided by
 * the span). That drift already averages in salary deposits, rent, and
 * everyday spending — but NOT upcoming credit-card auto pays, which are
 * discrete events we know about from each card's configuration. The forecast
 * walks forward day by day applying the drift and subtracting each auto pay
 * on the day it fires.
 */

export const SAFETY_BUFFER = 50_000; // cents — keep $500 in checking

export interface ForecastAutoPay {
  cardId: string;
  cardName: string;
  colorSlot: number;
  dateISO: string; // yyyy-mm-dd
  amount: number;
  balanceAfter: number; // projected checking balance after the withdrawal
  severity: "ok" | "tight" | "overdraft";
}

export interface ForecastPoint {
  dateISO: string;
  balance: number;
}

export interface ForecastIncome {
  incomeId: string;
  name: string;
  dateISO: string;
  amount: number;
}

export interface ForecastExpense {
  expenseId: string;
  name: string;
  dateISO: string;
  amount: number;
  /** True when the amount is still the estimate rather than a confirmed bill. */
  estimated: boolean;
  /** True when this occurrence has been corrected to an actual figure. */
  adjusted: boolean;
  /** True when corrected to 0: listed so it can be changed back, but not charged. */
  skipped: boolean;
}

export interface Forecast {
  currentChecking: number | null; // null = no checking data yet
  dailyDrift: number; // net cents per day observed in history (income included)
  baselineDailyDrift: number; // net of scheduled income and bills — the everyday burn rate
  hasSchedules: boolean; // true when the projection uses the baseline rather than the raw drift
  driftWindowDays: number; // how much history informed the drift
  points: ForecastPoint[]; // daily projection from today
  autoPays: ForecastAutoPay[]; // upcoming auto pays within the horizon
  incomes: ForecastIncome[]; // upcoming scheduled deposits within the horizon
  expenses: ForecastExpense[]; // upcoming scheduled bills within the horizon
  endOfMonthBalance: number | null;
  autoPayTotalThisMonth: number; // upcoming (not yet fired) this calendar month
  incomeTotalThisMonth: number; // scheduled deposits still to come this month
  expenseTotalThisMonth: number; // scheduled bills still to come this month
  payoffCapacity: number | null; // extra that could be paid this month beyond auto pays
  lowestPoint: ForecastPoint | null;
}

export const HORIZON_DAYS = 45;

const DAY = 86_400_000;

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface CheckingPoint {
  balance: number;
  recordedAt: Date;
}

export function estimateDailyDrift(
  history: CheckingPoint[],
  now = new Date()
): { drift: number; windowDays: number; from: Date | null; to: Date | null } {
  if (history.length < 2) return { drift: 0, windowDays: 0, from: null, to: null };
  const cutoff = now.getTime() - 90 * DAY;
  const window = history.filter((h) => h.recordedAt.getTime() >= cutoff);
  const pts = window.length >= 2 ? window : history.slice(-2);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const spanDays = (last.recordedAt.getTime() - first.recordedAt.getTime()) / DAY;
  if (spanDays < 3) {
    return { drift: 0, windowDays: Math.round(spanDays), from: null, to: null };
  }
  return {
    drift: Math.round((last.balance - first.balance) / spanDays),
    windowDays: Math.round(spanDays),
    from: first.recordedAt,
    to: last.recordedAt,
  };
}

/** Upcoming auto-pay events for a card within [from, to], given its current state. */
function upcomingAutoPays(
  card: CreditCard,
  state: { totalBalance: number; statementBalance: number },
  from: Date,
  to: Date
): { date: Date; amount: number }[] {
  if (card.autoPayDay == null || card.autoPayType === "NONE") return [];
  const events: { date: Date; amount: number }[] = [];
  const months = [
    { y: from.getFullYear(), m: from.getMonth() },
    { y: from.getMonth() === 11 ? from.getFullYear() + 1 : from.getFullYear(), m: (from.getMonth() + 1) % 12 },
    { y: from.getMonth() >= 10 ? from.getFullYear() + 1 : from.getFullYear(), m: (from.getMonth() + 2) % 12 },
  ];
  let remainingTotal = state.totalBalance;
  let remainingStatement = state.statementBalance;
  for (const { y, m } of months) {
    const date = autoPayDateInMonth(card.autoPayDay, y, m);
    if (date < from || date > to) continue;
    // After the next statement closes (1st of a future month), the amount due
    // rolls over: approximate the next statement balance with today's total.
    const isFutureStatement = date.getFullYear() !== from.getFullYear() || date.getMonth() !== from.getMonth();
    const amount = autoPayAmount(card, {
      totalBalance: remainingTotal,
      statementBalance: isFutureStatement ? remainingTotal : remainingStatement,
    });
    if (amount > 0) {
      events.push({ date, amount });
      remainingTotal = Math.max(0, remainingTotal - amount);
      remainingStatement = Math.max(0, remainingStatement - amount);
    }
  }
  return events;
}

export interface ScheduledOutgoings {
  expenses?: RecurringExpense[];
  adjustments?: ExpenseAdjustment[];
}

export function buildForecast(
  checkingHistory: CheckingPoint[],
  cards: CardWithState[],
  incomes: RecurringIncome[] = [],
  outgoings: ScheduledOutgoings = {},
  now = new Date()
): Forecast {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const horizonEnd = new Date(today.getTime() + HORIZON_DAYS * DAY);
  const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  const latest = checkingHistory.at(-1) ?? null;
  const { drift, windowDays, from, to } = estimateDailyDrift(checkingHistory, now);
  const allExpenses = outgoings.expenses ?? [];
  const activeIncomes = incomes.filter((i) => i.active);
  const activeExpenses = allExpenses.filter((e) => e.active);
  const adjustments = adjustmentIndex(outgoings.adjustments ?? []);

  // A schedule moved the recorded balance from its start date (if any) until
  // it was paused (if ever), so paused schedules still count up to then.
  const historicalOccurrences = (
    schedule: RecurringIncome | RecurringExpense,
    windowFrom: Date,
    windowTo: Date
  ): Date[] => {
    if (!schedule.active && !schedule.pausedAt) return [];
    const until = schedule.pausedAt && schedule.pausedAt < windowTo ? schedule.pausedAt : windowTo;
    return scheduleOccurrences({ ...schedule, active: true }, windowFrom, until);
  };

  // The observed drift already contains every salary and every rent cheque
  // that moved the recorded balance during the history window. Projecting
  // those schedules forward on top of the raw drift would count the same
  // money twice, so the modelled amounts for the same window are removed
  // first — income subtracted, expenses added back — leaving the residual
  // everyday spending. Projecting forward is then that baseline plus the
  // deposits and bills we know are coming, which is what turns a straight
  // line into the sawtooth you actually live.
  let historicalIncomePerDay = 0;
  let historicalExpensePerDay = 0;
  if (from && to && windowDays >= 3) {
    const windowIncome = incomes.reduce(
      (sum, income) => sum + historicalOccurrences(income, from, to).length * income.amount,
      0
    );
    historicalIncomePerDay = Math.round(windowIncome / windowDays);

    const windowExpense = allExpenses.reduce(
      (sum, expense) =>
        sum +
        historicalOccurrences(expense, from, to).reduce(
          (inner, date) => inner + amountForOccurrence(expense, date, adjustments),
          0
        ),
      0
    );
    historicalExpensePerDay = Math.round(windowExpense / windowDays);
  }
  const baselineDrift = drift - historicalIncomePerDay + historicalExpensePerDay;
  const hasSchedules = activeIncomes.length > 0 || activeExpenses.length > 0;

  // Deposits and bills dated on or before the latest recorded balance are
  // taken to be in it already; anything later, today included, is still to
  // come. The lists, totals and balance walk all share this one cut-off.
  const latestDay = latest
    ? new Date(latest.recordedAt.getFullYear(), latest.recordedAt.getMonth(), latest.recordedAt.getDate())
    : null;
  const scheduledFrom =
    latestDay && latestDay >= today
      ? new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
      : today;

  // Scheduled deposits ahead of us.
  const incomeEvents: ForecastIncome[] = activeIncomes
    .flatMap((income) =>
      scheduleOccurrences(income, scheduledFrom, horizonEnd).map((date) => ({
        incomeId: income.id,
        name: income.name,
        dateISO: toISODate(date),
        amount: income.amount,
      }))
    )
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO));

  // Scheduled bills ahead of us, each at its corrected amount where one has
  // been entered. A correction of 0 means the bill will not be charged; it is
  // kept (as skipped, at 0) so the correction can still be changed or reset.
  const expenseEvents: ForecastExpense[] = activeExpenses
    .flatMap((expense) =>
      scheduleOccurrences(expense, scheduledFrom, horizonEnd).map((date) => {
        const amount = amountForOccurrence(expense, date, adjustments);
        return {
          expenseId: expense.id,
          name: expense.name,
          dateISO: toISODate(date),
          amount,
          estimated: expense.estimated,
          adjusted: adjustments.has(occurrenceKey(expense.id, date)),
          skipped: amount <= 0,
        };
      })
    )
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO));

  // Collect auto-pay events across cards, keyed by day.
  const rawEvents: { card: CreditCard; date: Date; amount: number }[] = [];
  for (const { card, current } of cards) {
    if (!current || card.archivedAt) continue;
    for (const e of upcomingAutoPays(card, current, today, horizonEnd)) {
      rawEvents.push({ card, date: e.date, amount: e.amount });
    }
  }
  rawEvents.sort((a, b) => a.date.getTime() - b.date.getTime());

  const incomeTotalThisMonth = incomeEvents
    .filter((e) => e.dateISO <= toISODate(endOfMonth))
    .reduce((s, e) => s + e.amount, 0);
  const expenseTotalThisMonth = expenseEvents
    .filter((e) => e.dateISO <= toISODate(endOfMonth))
    .reduce((s, e) => s + e.amount, 0);

  if (!latest) {
    return {
      currentChecking: null,
      dailyDrift: drift,
      baselineDailyDrift: baselineDrift,
      hasSchedules,
      driftWindowDays: windowDays,
      points: [],
      autoPays: rawEvents.map(({ card, date, amount }) => ({
        cardId: card.id,
        cardName: card.name,
        colorSlot: card.colorSlot,
        dateISO: toISODate(date),
        amount,
        balanceAfter: 0,
        severity: "ok" as const,
      })),
      incomes: incomeEvents,
      expenses: expenseEvents,
      endOfMonthBalance: null,
      autoPayTotalThisMonth: rawEvents
        .filter((e) => e.date <= endOfMonth)
        .reduce((s, e) => s + e.amount, 0),
      incomeTotalThisMonth,
      expenseTotalThisMonth,
      payoffCapacity: null,
      lowestPoint: null,
    };
  }

  // Walk forward one day at a time.
  const points: ForecastPoint[] = [];
  const autoPays: ForecastAutoPay[] = [];
  let balance = latest.balance;
  let lowest: ForecastPoint = { dateISO: toISODate(today), balance };
  let endOfMonthBalance: number | null = null;

  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const day = new Date(today.getTime() + i * DAY);
    if (i > 0) balance += baselineDrift;
    // Deposits land before the day's auto pays, matching how a payday that
    // shares a date with a withdrawal actually plays out. Both lists already
    // start after the latest recorded balance, so day 0 is included.
    for (const e of incomeEvents) {
      if (e.dateISO === toISODate(day)) balance += e.amount;
    }
    for (const e of expenseEvents) {
      if (e.dateISO === toISODate(day)) balance -= e.amount;
    }
    for (const e of rawEvents) {
      if (toISODate(e.date) !== toISODate(day)) continue;
      balance -= e.amount;
      autoPays.push({
        cardId: e.card.id,
        cardName: e.card.name,
        colorSlot: e.card.colorSlot,
        dateISO: toISODate(day),
        amount: e.amount,
        balanceAfter: balance,
        severity: balance < 0 ? "overdraft" : balance < SAFETY_BUFFER ? "tight" : "ok",
      });
    }
    const point = { dateISO: toISODate(day), balance };
    points.push(point);
    if (balance < lowest.balance) lowest = point;
    if (toISODate(day) === toISODate(endOfMonth)) endOfMonthBalance = balance;
  }
  if (endOfMonthBalance === null) endOfMonthBalance = points.at(-1)?.balance ?? latest.balance;

  // What could still be paid off this month beyond scheduled auto pays,
  // keeping the safety buffer intact at the month's lowest projected point.
  const lowestThisMonth = points
    .filter((p) => p.dateISO <= toISODate(endOfMonth))
    .reduce((min, p) => (p.balance < min ? p.balance : min), Infinity);
  const payoffCapacity = Math.max(0, (lowestThisMonth === Infinity ? latest.balance : lowestThisMonth) - SAFETY_BUFFER);

  return {
    currentChecking: latest.balance,
    dailyDrift: drift,
    baselineDailyDrift: baselineDrift,
    hasSchedules,
    driftWindowDays: windowDays,
    points,
    autoPays,
    incomes: incomeEvents,
    expenses: expenseEvents,
    endOfMonthBalance,
    autoPayTotalThisMonth: autoPays
      .filter((e) => e.dateISO <= toISODate(endOfMonth))
      .reduce((s, e) => s + e.amount, 0),
    incomeTotalThisMonth,
    expenseTotalThisMonth,
    payoffCapacity,
    lowestPoint: lowest,
  };
}
