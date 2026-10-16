import type { CreditCard } from "@prisma/client";
import { autoPayAmount, autoPayDateInMonth } from "./domain";
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

export interface Forecast {
  currentChecking: number | null; // null = no checking data yet
  dailyDrift: number; // cents per day, from history
  driftWindowDays: number; // how much history informed the drift
  points: ForecastPoint[]; // daily projection from today
  autoPays: ForecastAutoPay[]; // upcoming auto pays within the horizon
  endOfMonthBalance: number | null;
  autoPayTotalThisMonth: number; // upcoming (not yet fired) this calendar month
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

export function estimateDailyDrift(history: CheckingPoint[]): { drift: number; windowDays: number } {
  if (history.length < 2) return { drift: 0, windowDays: 0 };
  const cutoff = Date.now() - 90 * DAY;
  const window = history.filter((h) => h.recordedAt.getTime() >= cutoff);
  const pts = window.length >= 2 ? window : history.slice(-2);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const spanDays = (last.recordedAt.getTime() - first.recordedAt.getTime()) / DAY;
  if (spanDays < 3) return { drift: 0, windowDays: Math.round(spanDays) };
  return {
    drift: Math.round((last.balance - first.balance) / spanDays),
    windowDays: Math.round(spanDays),
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

export function buildForecast(
  checkingHistory: CheckingPoint[],
  cards: CardWithState[],
  now = new Date()
): Forecast {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const horizonEnd = new Date(today.getTime() + HORIZON_DAYS * DAY);
  const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  const latest = checkingHistory.at(-1) ?? null;
  const { drift, windowDays } = estimateDailyDrift(checkingHistory);

  // Collect auto-pay events across cards, keyed by day.
  const rawEvents: { card: CreditCard; date: Date; amount: number }[] = [];
  for (const { card, current } of cards) {
    if (!current || card.archivedAt) continue;
    for (const e of upcomingAutoPays(card, current, today, horizonEnd)) {
      rawEvents.push({ card, date: e.date, amount: e.amount });
    }
  }
  rawEvents.sort((a, b) => a.date.getTime() - b.date.getTime());

  if (!latest) {
    return {
      currentChecking: null,
      dailyDrift: drift,
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
      endOfMonthBalance: null,
      autoPayTotalThisMonth: rawEvents
        .filter((e) => e.date <= endOfMonth)
        .reduce((s, e) => s + e.amount, 0),
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
    if (i > 0) balance += drift;
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
    driftWindowDays: windowDays,
    points,
    autoPays,
    endOfMonthBalance,
    autoPayTotalThisMonth: autoPays
      .filter((e) => e.dateISO <= toISODate(endOfMonth))
      .reduce((s, e) => s + e.amount, 0),
    payoffCapacity,
    lowestPoint: lowest,
  };
}
