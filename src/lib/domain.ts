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

/**
 * The actual calendar date auto pay fires in a given month, clamping
 * day-of-month to the month's length (e.g. day 31 in February → Feb 28/29).
 */
export function autoPayDateInMonth(autoPayDay: number, year: number, monthIndex: number): Date {
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  return new Date(year, monthIndex, Math.min(autoPayDay, daysInMonth));
}
