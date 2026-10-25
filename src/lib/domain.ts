// Enum-like values kept in app code because SQLite has no native enums.

export const AUTO_PAY_TYPES = ["STATEMENT", "FULL", "MINIMUM", "FIXED", "NONE"] as const;
export type AutoPayType = (typeof AUTO_PAY_TYPES)[number];

export const AUTO_PAY_LABELS: Record<AutoPayType, string> = {
  STATEMENT: "Statement balance (last month)",
  FULL: "Full current balance",
  MINIMUM: "Minimum payment",
  FIXED: "Fixed amount",
  NONE: "No auto pay",
};

export function isAutoPayType(value: string): value is AutoPayType {
  return (AUTO_PAY_TYPES as readonly string[]).includes(value);
}

export interface CardLike {
  autoPayType: string;
  autoPayFixedAmount: number | null;
  minimumPayment: number;
  autoPayDay: number | null;
}

/**
 * How much auto pay withdraws for a card given its current state.
 * Never more than the outstanding total — issuers don't overdraw a paid card.
 */
export function autoPayAmount(
  card: CardLike,
  state: { totalBalance: number; statementBalance: number }
): number {
  if (card.autoPayDay == null) return 0;
  let amount: number;
  switch (card.autoPayType) {
    case "STATEMENT":
      amount = state.statementBalance;
      break;
    case "FULL":
      amount = state.totalBalance;
      break;
    case "MINIMUM":
      amount = card.minimumPayment;
      break;
    case "FIXED":
      amount = card.autoPayFixedAmount ?? 0;
      break;
    default:
      return 0;
  }
  return Math.max(0, Math.min(amount, state.totalBalance));
}

/** True when the issuer withdraws a payment on a configured day each month. */
export function hasAutoPay(card: Pick<CardLike, "autoPayDay" | "autoPayType">): boolean {
  return card.autoPayDay != null && card.autoPayType !== "NONE";
}

/**
 * What this month's card payment will still take out of checking.
 *
 * Payments recorded this month come off the amount due, never below zero.
 * The statement and total in `state` are already net of recorded payments
 * (each payment writes a derived balance update), so only the fixed-size
 * auto pays need `paidThisMonth` subtracted explicitly. A card paid by hand
 * owes its remaining statement balance.
 */
export function plannedPaymentThisMonth(
  card: CardLike,
  state: { totalBalance: number; statementBalance: number },
  paidThisMonth: number
): number {
  let amount: number;
  if (!hasAutoPay(card)) {
    amount = state.statementBalance;
  } else {
    switch (card.autoPayType) {
      case "STATEMENT":
        amount = state.statementBalance;
        break;
      case "FULL":
        amount = state.totalBalance;
        break;
      case "MINIMUM":
        amount = card.minimumPayment - paidThisMonth;
        break;
      case "FIXED":
        amount = (card.autoPayFixedAmount ?? 0) - paidThisMonth;
        break;
      default:
        amount = 0;
    }
  }
  return Math.max(0, Math.min(amount, state.totalBalance));
}

/**
 * The actual calendar date auto pay fires in a given month, clamping
 * day-of-month to the month's length (e.g. day 31 in February → Feb 28/29).
 */
export function autoPayDateInMonth(autoPayDay: number, year: number, monthIndex: number): Date {
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  return new Date(year, monthIndex, Math.min(autoPayDay, daysInMonth));
}

// ---------------------------------------------------------------------------
// Repeating schedules — shared by recurring income and recurring expenses
// ---------------------------------------------------------------------------

export const SCHEDULE_FREQUENCIES = ["MONTHLY", "SEMI_MONTHLY", "BIWEEKLY", "WEEKLY"] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export const SCHEDULE_FREQUENCY_LABELS: Record<ScheduleFrequency, string> = {
  MONTHLY: "Monthly",
  SEMI_MONTHLY: "Twice a month",
  BIWEEKLY: "Every two weeks",
  WEEKLY: "Weekly",
};

export function isScheduleFrequency(value: string): value is ScheduleFrequency {
  return (SCHEDULE_FREQUENCIES as readonly string[]).includes(value);
}

/** True when the frequency pays on fixed days of the month rather than a cycle. */
export function usesDayOfMonth(frequency: string): boolean {
  return frequency === "MONTHLY" || frequency === "SEMI_MONTHLY";
}

export interface ScheduleLike {
  amount: number;
  frequency: string;
  dayOfMonth: number | null;
  secondDayOfMonth: number | null;
  anchorDate: Date | null;
  startDate?: Date | null;
  active?: boolean;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Every pay date in [from, to], inclusive.
 *
 * Dates are stepped with setDate rather than by adding milliseconds so a
 * daylight-saving transition inside the range cannot shift a payday by a day.
 */
export function scheduleOccurrences(schedule: ScheduleLike, from: Date, to: Date): Date[] {
  if (schedule.active === false) return [];
  const start =
    schedule.startDate && schedule.startDate > from ? startOfDay(schedule.startDate) : startOfDay(from);
  const end = startOfDay(to);
  if (end < start) return [];

  const dates: Date[] = [];

  if (usesDayOfMonth(schedule.frequency)) {
    const days = [schedule.dayOfMonth, schedule.secondDayOfMonth]
      .filter((d): d is number => d != null && d >= 1 && d <= 31)
      .sort((a, b) => a - b);
    if (days.length === 0) return [];

    // Walk months from the one containing `start` to the one containing `end`.
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= end) {
      const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      for (const day of days) {
        const date = new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(day, daysInMonth));
        if (date >= start && date <= end) dates.push(date);
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }
    // SEMI_MONTHLY with both days equal would otherwise pay twice on one date.
    return dedupeDates(dates);
  }

  if (!schedule.anchorDate) return [];
  const step = schedule.frequency === "WEEKLY" ? 7 : 14;
  const anchor = startOfDay(schedule.anchorDate);

  // Jump straight to the first occurrence at or after `start`. The cycle runs
  // both ways from the anchor: it is usually the most recent pay date, so a
  // history window lies almost entirely before it.
  const cursor = new Date(anchor);
  const daysFromAnchor = Math.round((start.getTime() - anchor.getTime()) / 86_400_000);
  cursor.setDate(cursor.getDate() + Math.ceil(daysFromAnchor / step) * step);
  while (cursor < start) cursor.setDate(cursor.getDate() + step);

  while (cursor <= end) {
    if (cursor >= start) dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + step);
  }
  return dates;
}

function dedupeDates(dates: Date[]): Date[] {
  const seen = new Set<number>();
  const out: Date[] = [];
  for (const d of dates.sort((a, b) => a.getTime() - b.getTime())) {
    if (seen.has(d.getTime())) continue;
    seen.add(d.getTime());
    out.push(d);
  }
  return out;
}

/** The next pay date on or after `from`, or null if the schedule is unusable. */
export function nextOccurrenceDate(schedule: ScheduleLike, from: Date): Date | null {
  const horizon = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 70);
  return scheduleOccurrences(schedule, from, horizon)[0] ?? null;
}

function localISODate(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Stable key for one occurrence of a schedule, used to match adjustments. */
export function occurrenceKey(scheduleId: string, date: Date): string {
  return `${scheduleId}:${localISODate(date)}`;
}

/**
 * Schedule dates as yyyy-mm-dd for date inputs. Formatted on the server with
 * the same local-midnight convention the actions parse with, so an edit form
 * round-trips the stored date whatever the browser's time zone.
 */
export function scheduleDateInputs(schedule: Pick<ScheduleLike, "anchorDate" | "startDate">): {
  anchorDateISO: string | null;
  startDateISO: string | null;
} {
  return {
    anchorDateISO: schedule.anchorDate ? localISODate(schedule.anchorDate) : null,
    startDateISO: schedule.startDate ? localISODate(schedule.startDate) : null,
  };
}

export interface AdjustmentLike {
  expenseId: string;
  dueDate: Date;
  amount: number;
}

/**
 * Index adjustments so a forecast can look up "what will this bill actually
 * be on this date" in constant time.
 */
export function adjustmentIndex(adjustments: AdjustmentLike[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const a of adjustments) {
    index.set(occurrenceKey(a.expenseId, a.dueDate), a.amount);
  }
  return index;
}

/** The amount actually expected for one occurrence: the correction if any, else the estimate. */
export function amountForOccurrence(
  expense: { id: string; amount: number },
  date: Date,
  adjustments: Map<string, number>
): number {
  const adjusted = adjustments.get(occurrenceKey(expense.id, date));
  return adjusted ?? expense.amount;
}

/** Average amount per month, for display and comparison across cadences. */
export function monthlyEquivalent(schedule: ScheduleLike): number {
  switch (schedule.frequency) {
    case "MONTHLY":
      return schedule.amount;
    case "SEMI_MONTHLY":
      return schedule.amount * 2;
    case "BIWEEKLY":
      return Math.round((schedule.amount * 26) / 12);
    case "WEEKLY":
      return Math.round((schedule.amount * 52) / 12);
    default:
      return 0;
  }
}
