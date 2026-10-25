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
  hasAutoPay,
  occurrenceKey,
  plannedPaymentThisMonth,
  scheduleOccurrences,
} from "./domain";
import type { CardWithState } from "./queries";

/**
 * Cash-flow forecast of the checking account.
 *
 * The projection starts from the latest recorded balance and replays the
 * money we know is going to move:
 *
 *   - scheduled income on its pay dates;
 *   - scheduled bills on their due dates, at corrected amounts where known;
 *   - this month's card payments: what is still due after the payments
 *     already recorded this month (never below zero), on the auto pay day or
 *     the day the card is usually paid by hand;
 *   - later card payments: each card's next statement is estimated from its
 *     typical monthly charges (new spending observed on the card), and the
 *     card's auto pay rule — or its usual manual payment — is applied to it.
 *
 * Only after all of that is removed does history come in: whatever change in
 * the recorded balance is NOT explained by those events becomes a small
 * "other spending" rate per day. Past salaries, rent and card payments all
 * moved the recorded balance, so they must be taken back out of the observed
 * drift before projecting; otherwise every card payment would be counted
 * once in the drift and again on the day it fires, which is exactly the
 * runaway-negative forecast this model replaces.
 */

export const SAFETY_BUFFER = 50_000; // cents — keep $500 in checking
export const HORIZON_DAYS = 45;
/** How far back history is read, for both checking drift and card behaviour. */
export const HISTORY_DAYS = 90;
/** Below this much history the unexplained residual is too noisy to project. */
export const MIN_WINDOW_DAYS = 14;

const DAY = 86_400_000;
const DAYS_PER_MONTH = 365.25 / 12;

export interface ForecastCardPayment {
  cardId: string;
  cardName: string;
  colorSlot: number;
  dateISO: string; // yyyy-mm-dd
  amount: number;
  balanceAfter: number; // projected checking balance after the withdrawal
  severity: "ok" | "tight" | "overdraft";
  /** Withdrawn by the issuer on the configured day, or paid by hand. */
  kind: "autopay" | "manual";
  /** True for later months, where the statement is estimated from typical charges. */
  estimated: boolean;
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

export interface ForecastCardProfile {
  cardId: string;
  /** New spending per month observed on the card; null without enough history. */
  typicalMonthlyCharges: number | null;
  /** Average recorded payments per month; null when none are recorded. */
  typicalMonthlyPayment: number | null;
  /** Day of the month the card is usually paid, from recorded payments. */
  typicalPaymentDay: number | null;
}

export interface Forecast {
  currentChecking: number | null; // null = no checking data yet
  dailyDrift: number; // raw change in the recorded balance per day
  /**
   * Change per day left over once scheduled income, bills and card payments
   * in the history window are accounted for. The projection walks with this.
   */
  otherSpendingPerDay: number;
  driftWindowDays: number; // how much history informed the drift
  /** True when the residual is backed by enough history to be projected. */
  usesHistory: boolean;
  points: ForecastPoint[]; // daily projection from today
  cardPayments: ForecastCardPayment[]; // upcoming card payments within the horizon
  cardProfiles: ForecastCardProfile[];
  incomes: ForecastIncome[]; // upcoming scheduled deposits within the horizon
  expenses: ForecastExpense[]; // upcoming scheduled bills within the horizon
  endOfMonthBalance: number | null;
  /** Remaining statement balances across cards, net of recorded payments. */
  dueThisMonth: number;
  cardPaymentTotalThisMonth: number; // card payments still to leave checking this month
  incomeTotalThisMonth: number; // scheduled deposits still to come this month
  expenseTotalThisMonth: number; // scheduled bills still to come this month
  payoffCapacity: number | null; // extra that could be paid this month beyond planned payments
  lowestPoint: ForecastPoint | null;
}

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface CheckingPoint {
  balance: number;
  recordedAt: Date;
}

export interface CardPaymentPoint {
  cardId: string;
  amount: number;
  paidAt: Date;
}

export interface CardUpdatePoint {
  cardId: string;
  totalBalance: number;
  statementBalance: number;
  kind: string;
  recordedAt: Date;
}

export interface ForecastInput {
  checkingHistory: CheckingPoint[];
  cards: CardWithState[];
  incomes?: RecurringIncome[];
  expenses?: RecurringExpense[];
  adjustments?: ExpenseAdjustment[];
  /** Recorded card payments, ideally covering HISTORY_DAYS. */
  cardPayments?: CardPaymentPoint[];
  /** Card balance updates, ideally covering HISTORY_DAYS. */
  cardUpdates?: CardUpdatePoint[];
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export function estimateDailyDrift(
  history: CheckingPoint[],
  now = new Date()
): { drift: number; windowDays: number; from: Date | null; to: Date | null } {
  if (history.length < 2) return { drift: 0, windowDays: 0, from: null, to: null };
  const cutoff = now.getTime() - HISTORY_DAYS * DAY;
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

/**
 * What a card's history says about how it is used: how much new spending
 * lands on it per month, how much is paid per month, and on what day.
 *
 * New charges over a window are `(latest total − earliest total) + payments
 * in between`: the balance would have grown by the charges alone, and every
 * payment hid some of that growth. When no payments are recorded this
 * collapses to the balance change, which can read as zero for a card that is
 * paid off monthly — so the average of recent statement balances is used as
 * the fallback.
 */
export function profileCard(
  cardId: string,
  updates: CardUpdatePoint[],
  payments: CardPaymentPoint[],
  now = new Date()
): ForecastCardProfile {
  const cutoff = now.getTime() - HISTORY_DAYS * DAY;
  const ups = updates
    .filter((u) => u.cardId === cardId)
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  const pays = payments
    .filter((p) => p.cardId === cardId && p.paidAt.getTime() >= cutoff)
    .sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime());

  // Spending observed between the first and last update in the window.
  let chargesPerMonth: number | null = null;
  const inWindow = ups.filter((u) => u.recordedAt.getTime() >= cutoff);
  if (inWindow.length >= 2) {
    const first = inWindow[0];
    const last = inWindow[inWindow.length - 1];
    const span = (last.recordedAt.getTime() - first.recordedAt.getTime()) / DAY;
    if (span >= MIN_WINDOW_DAYS) {
      const paidBetween = pays
        .filter((p) => p.paidAt > first.recordedAt && p.paidAt <= last.recordedAt)
        .reduce((s, p) => s + p.amount, 0);
      const charges = last.totalBalance - first.totalBalance + paidBetween;
      chargesPerMonth = Math.max(0, Math.round((charges / span) * DAYS_PER_MONTH));
    }
  }

  // Fallback: the statement balance is last month's spending. Take the
  // highest figure entered in each of the last three months (later entries
  // in a month may already be net of payments) and average them.
  const statementByMonth = new Map<string, number>();
  for (const u of ups) {
    if (u.kind !== "SNAPSHOT") continue;
    const key = `${u.recordedAt.getFullYear()}-${u.recordedAt.getMonth()}`;
    statementByMonth.set(key, Math.max(statementByMonth.get(key) ?? 0, u.statementBalance));
  }
  const recentStatements = [...statementByMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-3)
    .map(([, v]) => v);
  const statementAverage =
    recentStatements.length > 0
      ? Math.round(recentStatements.reduce((s, v) => s + v, 0) / recentStatements.length)
      : null;

  const typicalMonthlyCharges =
    chargesPerMonth != null && chargesPerMonth > 0 ? chargesPerMonth : statementAverage ?? chargesPerMonth;

  // Payment habits over the window (or since the card's first record).
  let typicalMonthlyPayment: number | null = null;
  let typicalPaymentDay: number | null = null;
  if (pays.length > 0) {
    const windowStart = Math.max(cutoff, ups[0]?.recordedAt.getTime() ?? cutoff);
    const span = (now.getTime() - windowStart) / DAY;
    if (span >= MIN_WINDOW_DAYS) {
      const total = pays.reduce((s, p) => s + p.amount, 0);
      typicalMonthlyPayment = Math.round((total / span) * DAYS_PER_MONTH);
    }
    const days = pays.map((p) => p.paidAt.getDate()).sort((a, b) => a - b);
    typicalPaymentDay = days[Math.floor(days.length / 2)];
  }

  return { cardId, typicalMonthlyCharges, typicalMonthlyPayment, typicalPaymentDay };
}

interface CardEvent {
  card: CreditCard;
  date: Date;
  amount: number;
  kind: "autopay" | "manual";
  estimated: boolean;
}

/**
 * The payments one card will take out of checking inside the horizon.
 *
 * This month uses what is actually known: the remaining amount due after the
 * payments already recorded. Later months carry the card forward — charges
 * still to come this cycle become part of the next statement, after which
 * each month adds a typical month of charges — and apply the card's payment
 * rule to that estimated state.
 */
function projectCardPayments(
  card: CreditCard,
  state: { totalBalance: number; statementBalance: number; recordedAt: Date },
  paidThisMonth: number,
  profile: ForecastCardProfile,
  today: Date,
  scheduledFrom: Date,
  horizonEnd: Date
): CardEvent[] {
  const events: CardEvent[] = [];
  const auto = hasAutoPay(card);
  const kind = auto ? "autopay" : "manual";
  const y = today.getFullYear();
  const m = today.getMonth();

  const paymentDate = (year: number, monthIndex: number): Date => {
    const dim = daysInMonth(year, monthIndex);
    if (auto) return autoPayDateInMonth(card.autoPayDay!, year, monthIndex);
    return new Date(year, monthIndex, Math.min(profile.typicalPaymentDay ?? dim, dim));
  };

  // --- This month: the remaining amount due, on the day it is paid. ---
  let total = state.totalBalance;
  const dueNow = plannedPaymentThisMonth(card, state, paidThisMonth);
  let dateNow: Date | null = paymentDate(y, m);
  if (dateNow < scheduledFrom) {
    // An auto pay whose day has passed already fired; a manual payment that
    // is overdue is assumed to be made now.
    dateNow = auto ? null : scheduledFrom;
  }
  if (dateNow && dueNow > 0 && dateNow <= horizonEnd) {
    events.push({ card, date: dateNow, amount: dueNow, kind, estimated: false });
    total -= dueNow;
  }

  // --- Later months: estimated statements. ---
  // Whatever sat on the card above the statement when it was last recorded
  // is this cycle's spending up to that day; the rest of the month adds a
  // proportional share of a typical month, and that sum becomes next
  // month's statement. A card last recorded in an earlier month tells us
  // nothing about this cycle, so a whole typical month is assumed.
  const recordedThisMonth =
    state.recordedAt.getFullYear() === y && state.recordedAt.getMonth() === m;
  const accrued = recordedThisMonth ? Math.max(0, state.totalBalance - state.statementBalance) : 0;
  const elapsed = recordedThisMonth ? state.recordedAt.getDate() / daysInMonth(y, m) : 0;
  const typical = profile.typicalMonthlyCharges ?? Math.round(accrued / Math.max(elapsed, 0.25));
  const stillToCome = Math.round(typical * (1 - elapsed));
  let statement = accrued + stillToCome;
  total += stillToCome;

  for (let k = 1; k <= 2; k++) {
    const date = new Date(y, m + k, 1);
    const year = date.getFullYear();
    const monthIndex = date.getMonth();
    const when = paymentDate(year, monthIndex);
    if (when > horizonEnd) break;
    const ruleAmount = auto
      ? autoPayAmount(card, { totalBalance: total, statementBalance: statement })
      : profile.typicalMonthlyPayment ?? statement;
    const amount = Math.max(0, Math.min(ruleAmount, total));
    if (amount > 0 && when >= scheduledFrom) {
      events.push({ card, date: when, amount, kind, estimated: true });
    }
    total -= amount;
    total += typical;
    statement = typical;
  }
  return events;
}

export function buildForecast(input: ForecastInput, now = new Date()): Forecast {
  const checkingHistory = input.checkingHistory;
  const incomes = input.incomes ?? [];
  const allExpenses = input.expenses ?? [];
  const cardPayments = input.cardPayments ?? [];
  const cardUpdates = input.cardUpdates ?? [];

  const today = startOfDay(now);
  const horizonEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + HORIZON_DAYS);
  const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const endOfMonthISO = toISODate(endOfMonth);

  const latest = checkingHistory.at(-1) ?? null;
  const { drift, windowDays, from, to } = estimateDailyDrift(checkingHistory, now);
  const activeIncomes = incomes.filter((i) => i.active);
  const activeExpenses = allExpenses.filter((e) => e.active);
  const adjustments = adjustmentIndex(input.adjustments ?? []);
  const activeCards = input.cards.filter(({ card, current }) => current && !card.archivedAt);

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

  // The residual: observed drift minus everything the model already replays
  // for that window. Each term here is projected forward discretely, so each
  // must be taken out of the history it also shaped.
  let otherSpendingPerDay = 0;
  const usesHistory = Boolean(from && to && windowDays >= MIN_WINDOW_DAYS);
  if (from && to && usesHistory) {
    const windowIncome = incomes.reduce(
      (sum, income) => sum + historicalOccurrences(income, from, to).length * income.amount,
      0
    );
    const windowExpense = allExpenses.reduce(
      (sum, expense) =>
        sum +
        historicalOccurrences(expense, from, to).reduce(
          (inner, date) => inner + amountForOccurrence(expense, date, adjustments),
          0
        ),
      0
    );
    // A payment recorded in the same transaction as the window's opening
    // balance is already inside that balance, hence the open lower bound.
    const windowCardPayments = cardPayments
      .filter((p) => p.paidAt > from && p.paidAt <= to)
      .reduce((sum, p) => sum + p.amount, 0);
    const observed = drift * windowDays;
    otherSpendingPerDay = Math.round(
      (observed - windowIncome + windowExpense + windowCardPayments) / windowDays
    );
  }

  // Deposits and bills dated on or before the latest recorded balance are
  // taken to be in it already; anything later, today included, is still to
  // come. The lists, totals and balance walk all share this one cut-off.
  const latestDay = latest ? startOfDay(latest.recordedAt) : null;
  const scheduledFrom =
    latestDay && latestDay >= today
      ? new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
      : today;

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

  // Card payments across cards, this month from the known state and later
  // months from each card's profile.
  const cardProfiles: ForecastCardProfile[] = [];
  const rawEvents: CardEvent[] = [];
  let dueThisMonth = 0;
  for (const { card, current, paidThisMonth } of activeCards) {
    if (!current) continue;
    const profile = profileCard(card.id, cardUpdates, cardPayments, now);
    cardProfiles.push(profile);
    dueThisMonth += current.statementBalance;
    rawEvents.push(
      ...projectCardPayments(card, current, paidThisMonth ?? 0, profile, today, scheduledFrom, horizonEnd)
    );
  }
  rawEvents.sort((a, b) => a.date.getTime() - b.date.getTime());

  const incomeTotalThisMonth = incomeEvents
    .filter((e) => e.dateISO <= endOfMonthISO)
    .reduce((s, e) => s + e.amount, 0);
  const expenseTotalThisMonth = expenseEvents
    .filter((e) => e.dateISO <= endOfMonthISO)
    .reduce((s, e) => s + e.amount, 0);
  const cardPaymentTotalThisMonth = rawEvents
    .filter((e) => e.date <= endOfMonth)
    .reduce((s, e) => s + e.amount, 0);

  const toForecastPayment = (e: CardEvent, balanceAfter: number): ForecastCardPayment => ({
    cardId: e.card.id,
    cardName: e.card.name,
    colorSlot: e.card.colorSlot,
    dateISO: toISODate(e.date),
    amount: e.amount,
    balanceAfter,
    severity: balanceAfter < 0 ? "overdraft" : balanceAfter < SAFETY_BUFFER ? "tight" : "ok",
    kind: e.kind,
    estimated: e.estimated,
  });

  if (!latest) {
    return {
      currentChecking: null,
      dailyDrift: drift,
      otherSpendingPerDay,
      driftWindowDays: windowDays,
      usesHistory,
      points: [],
      cardPayments: rawEvents.map((e) => ({ ...toForecastPayment(e, 0), severity: "ok" as const })),
      cardProfiles,
      incomes: incomeEvents,
      expenses: expenseEvents,
      endOfMonthBalance: null,
      dueThisMonth,
      cardPaymentTotalThisMonth,
      incomeTotalThisMonth,
      expenseTotalThisMonth,
      payoffCapacity: null,
      lowestPoint: null,
    };
  }

  // Walk forward one day at a time.
  const points: ForecastPoint[] = [];
  const cardPaymentEvents: ForecastCardPayment[] = [];
  let balance = latest.balance;
  let lowest: ForecastPoint = { dateISO: toISODate(today), balance };
  let endOfMonthBalance: number | null = null;

  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const dayISO = toISODate(day);
    if (i > 0) balance += otherSpendingPerDay;
    // Deposits land before the day's withdrawals, matching how a payday that
    // shares a date with a payment actually plays out. Every list already
    // starts after the latest recorded balance, so day 0 is included.
    for (const e of incomeEvents) {
      if (e.dateISO === dayISO) balance += e.amount;
    }
    for (const e of expenseEvents) {
      if (e.dateISO === dayISO) balance -= e.amount;
    }
    for (const e of rawEvents) {
      if (toISODate(e.date) !== dayISO) continue;
      balance -= e.amount;
      cardPaymentEvents.push(toForecastPayment(e, balance));
    }
    const point = { dateISO: dayISO, balance };
    points.push(point);
    if (balance < lowest.balance) lowest = point;
    if (dayISO === endOfMonthISO) endOfMonthBalance = balance;
  }
  if (endOfMonthBalance === null) endOfMonthBalance = points.at(-1)?.balance ?? latest.balance;

  // What could still be paid off this month beyond the planned payments,
  // keeping the safety buffer intact at the month's lowest projected point.
  const lowestThisMonth = points
    .filter((p) => p.dateISO <= endOfMonthISO)
    .reduce((min, p) => (p.balance < min ? p.balance : min), Infinity);
  const payoffCapacity = Math.max(
    0,
    (lowestThisMonth === Infinity ? latest.balance : lowestThisMonth) - SAFETY_BUFFER
  );

  return {
    currentChecking: latest.balance,
    dailyDrift: drift,
    otherSpendingPerDay,
    driftWindowDays: windowDays,
    usesHistory,
    points,
    cardPayments: cardPaymentEvents,
    cardProfiles,
    incomes: incomeEvents,
    expenses: expenseEvents,
    endOfMonthBalance,
    dueThisMonth,
    cardPaymentTotalThisMonth,
    incomeTotalThisMonth,
    expenseTotalThisMonth,
    payoffCapacity,
    lowestPoint: lowest,
  };
}
