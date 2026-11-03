import type { CreditCard, Prisma, RecurringExpense } from "@prisma/client";
import { format } from "date-fns";
import { prisma } from "./db";
import {
  adjustmentIndex,
  amountForOccurrence,
  autoPayDateInMonth,
  hasAutoPay,
  plannedPaymentThisMonth,
  scheduleOccurrences,
} from "./domain";
import { formatCents } from "./money";

/**
 * Settlement: turning the schedule into balance movements.
 *
 * The forecast knows which bills and card auto pays are coming; until now the
 * balances only moved when the user typed them in. Settlement closes that
 * gap. It runs at the top of every page render and, for the signed-in user,
 * looks at every scheduled bill occurrence and every card auto pay whose date
 * has arrived but has not been dealt with yet, and deals with it once:
 *
 *   - a bill lowers the checking balance by its amount (corrected amount if
 *     one has been entered for that date);
 *   - an auto pay records a card payment for what the card's rule says was
 *     due that day, lowers the card's balance by it, and lowers checking by
 *     the same amount.
 *
 * Every occurrence gets exactly one ScheduledPosting row, keyed by
 * (kind, source, due date), so re-running is harmless and two overlapping
 * requests cannot post the same thing twice (the unique index decides).
 *
 * What is NOT posted:
 *   - anything due before the user's `settleFrom` day, which is set to the
 *     day of their first visit after this feature arrived. Before that day
 *     they were moving balances by hand, and re-posting would double count;
 *   - anything due before the schedule was entered or the card's auto pay
 *     rule was last set: the app did not know about it, and the user set
 *     things up knowing their current balance;
 *   - anything already inside a balance the user entered afterwards. A
 *     checking SNAPSHOT dated on or after the due date is taken to include
 *     the bill; a card SNAPSHOT dated on or after the auto pay date is taken
 *     to include the payment. Such occurrences are recorded as ABSORBED, and
 *     an absorbed auto pay still gets a CardPayment row (dated on the due
 *     date, with no balance change) so payment history stays complete and
 *     the forecast can take it back out of the checking drift.
 *
 * Derived updates (an expense, a one-time income, a payment) do not count as
 * knowledge of the bank balance, so they never absorb anything: they are
 * deltas applied to whatever was recorded before.
 *
 * Posted balance updates are dated at the moment of posting (`now`), not on
 * the due date, so they are always the newest record on their account and
 * the running balance stays a simple chain. The posting row keeps the due
 * date for display.
 */

export type PostingKind = "BILL" | "AUTOPAY";
export type PostingOutcome = "POSTED" | "ABSORBED" | "NOTHING_DUE";

export interface SettledEvent {
  kind: PostingKind;
  label: string;
  dueDate: Date;
  amount: number;
  outcome: PostingOutcome;
}

type Tx = Prisma.TransactionClient;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function nextDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

function laterOf(first: Date, ...rest: Date[]): Date {
  return rest.reduce((a, b) => (b > a ? b : a), first);
}

function dueLabel(due: Date): string {
  return format(due, "MMM d");
}

interface Candidate {
  kind: PostingKind;
  dueDate: Date;
  expense?: RecurringExpense;
  card?: CreditCard;
}

/** Posting rows keyed the way the unique index is, for a cheap "seen" check. */
function postingKey(kind: string, sourceId: string, dueDate: Date): string {
  return `${kind}:${sourceId}:${startOfDay(dueDate).getTime()}`;
}

/**
 * Posts everything due on or before `now` for one user and returns what was
 * decided this time (empty when there was nothing new). Safe to call on
 * every request.
 */
export async function settleDueEvents(userId: string, now = new Date()): Promise<SettledEvent[]> {
  const today = startOfDay(now);

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { settleFrom: true } });
  if (!user) return [];
  let floor: Date;
  if (user.settleFrom) {
    floor = startOfDay(user.settleFrom);
  } else {
    // First visit since the feature arrived: nothing before today is posted.
    floor = today;
    await prisma.user.update({ where: { id: userId }, data: { settleFrom: today } });
  }

  const [account, expenses, cards, existing] = await Promise.all([
    prisma.checkingAccount.findFirst({ where: { userId }, select: { id: true } }),
    prisma.recurringExpense.findMany({ where: { active: true, account: { userId } } }),
    prisma.creditCard.findMany({ where: { userId, archivedAt: null } }),
    prisma.scheduledPosting.findMany({
      where: { userId, dueDate: { gte: floor } },
      select: { kind: true, sourceId: true, dueDate: true },
    }),
  ]);
  const seen = new Set(existing.map((p) => postingKey(p.kind, p.sourceId, p.dueDate)));

  const candidates: Candidate[] = [];

  for (const expense of expenses) {
    const from = laterOf(floor, startOfDay(expense.createdAt));
    for (const dueDate of scheduleOccurrences(expense, from, today)) {
      if (seen.has(postingKey("BILL", expense.id, dueDate))) continue;
      candidates.push({ kind: "BILL", dueDate, expense });
    }
  }

  for (const card of cards) {
    if (!hasAutoPay(card)) continue;
    const from = laterOf(floor, startOfDay(card.autoPaySetAt ?? card.createdAt));
    const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
    while (cursor <= today) {
      const dueDate = autoPayDateInMonth(card.autoPayDay!, cursor.getFullYear(), cursor.getMonth());
      if (dueDate >= from && dueDate <= today && !seen.has(postingKey("AUTOPAY", card.id, dueDate))) {
        candidates.push({ kind: "AUTOPAY", dueDate, card });
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }

  if (candidates.length === 0) return [];
  candidates.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  // The user's view of the bank, which decides what is already accounted for.
  const latestSnapshot = account
    ? await prisma.checkingBalanceUpdate.findFirst({
        where: { accountId: account.id, kind: "SNAPSHOT" },
        orderBy: { recordedAt: "desc" },
        select: { recordedAt: true },
      })
    : null;
  const snapshotDay = latestSnapshot ? startOfDay(latestSnapshot.recordedAt) : null;
  const hasCheckingBalance = account
    ? (await prisma.checkingBalanceUpdate.count({ where: { accountId: account.id } })) > 0
    : false;
  const checkingAbsorbs = (due: Date): boolean =>
    // Nothing to post against yet: the first balance entered will include it.
    !hasCheckingBalance || (snapshotDay != null && snapshotDay >= due);

  const adjustments = adjustmentIndex(
    await prisma.expenseAdjustment.findMany({
      where: { expense: { account: { userId } }, dueDate: { gte: floor, lte: today } },
    })
  );

  const results: SettledEvent[] = [];
  for (const [index, candidate] of candidates.entries()) {
    // Each posting in a run gets its own timestamp, a millisecond apart, so
    // "latest update" is unambiguous and the balance chain stays in order.
    const stamp = new Date(now.getTime() + index);
    try {
      const result = await prisma.$transaction(async (tx) => {
        if (candidate.kind === "BILL") {
          if (!account || !hasCheckingBalance) return null; // retried once a balance exists
          const amount = amountForOccurrence(candidate.expense!, candidate.dueDate, adjustments);
          return postBill(tx, userId, account.id, candidate.expense!, candidate.dueDate, amount, checkingAbsorbs, stamp);
        }
        return postAutoPay(tx, userId, account?.id ?? null, candidate.card!, candidate.dueDate, checkingAbsorbs, stamp);
      });
      if (result) results.push(result);
    } catch (e) {
      // Another request posted this occurrence first; its row wins.
      if (e instanceof Error && "code" in e && (e as { code?: string }).code === "P2002") continue;
      throw e;
    }
  }
  return results;
}

async function postBill(
  tx: Tx,
  userId: string,
  accountId: string,
  expense: RecurringExpense,
  dueDate: Date,
  amount: number,
  checkingAbsorbs: (due: Date) => boolean,
  now: Date
): Promise<SettledEvent> {
  const base = { userId, kind: "BILL", sourceId: expense.id, dueDate, label: expense.name, amount, postedAt: now };

  if (amount <= 0) {
    await tx.scheduledPosting.create({ data: { ...base, outcome: "NOTHING_DUE" } });
    return { kind: "BILL", label: expense.name, dueDate, amount, outcome: "NOTHING_DUE" };
  }
  if (checkingAbsorbs(dueDate)) {
    await tx.scheduledPosting.create({ data: { ...base, outcome: "ABSORBED" } });
    return { kind: "BILL", label: expense.name, dueDate, amount, outcome: "ABSORBED" };
  }

  const latest = await tx.checkingBalanceUpdate.findFirstOrThrow({
    where: { accountId },
    orderBy: { recordedAt: "desc" },
  });
  const update = await tx.checkingBalanceUpdate.create({
    data: {
      accountId,
      balance: latest.balance - amount,
      reason: `${expense.name} (scheduled bill due ${dueLabel(dueDate)})`,
      kind: "SCHEDULED",
      recordedAt: now,
    },
  });
  await tx.scheduledPosting.create({ data: { ...base, outcome: "POSTED", checkingUpdateId: update.id } });
  return { kind: "BILL", label: expense.name, dueDate, amount, outcome: "POSTED" };
}

async function postAutoPay(
  tx: Tx,
  userId: string,
  accountId: string | null,
  card: CreditCard,
  dueDate: Date,
  checkingAbsorbs: (due: Date) => boolean,
  now: Date
): Promise<SettledEvent> {
  const base = { userId, kind: "AUTOPAY", sourceId: card.id, dueDate, label: card.name, postedAt: now };
  const dayAfter = nextDay(dueDate);

  // What the issuer saw on the day: the card as last recorded by then, and
  // the payments already made that month, which reduce a fixed-size pull.
  const stateAtDue = await tx.cardBalanceUpdate.findFirst({
    where: { cardId: card.id, recordedAt: { lt: dayAfter } },
    orderBy: { recordedAt: "desc" },
  });
  const monthStart = new Date(dueDate.getFullYear(), dueDate.getMonth(), 1);
  const paidBefore = await tx.cardPayment.aggregate({
    where: { cardId: card.id, paidAt: { gte: monthStart, lt: dayAfter } },
    _sum: { amount: true },
  });
  const amount = stateAtDue ? plannedPaymentThisMonth(card, stateAtDue, paidBefore._sum.amount ?? 0) : 0;

  if (amount <= 0) {
    await tx.scheduledPosting.create({ data: { ...base, amount: 0, outcome: "NOTHING_DUE" } });
    return { kind: "AUTOPAY", label: card.name, dueDate, amount: 0, outcome: "NOTHING_DUE" };
  }

  // The payment itself always goes on record, dated when the issuer took it.
  const payment = await tx.cardPayment.create({
    data: { cardId: card.id, amount, note: "Auto pay", paidAt: dueDate },
  });

  const cardSnapshotSince = await tx.cardBalanceUpdate.findFirst({
    where: { cardId: card.id, kind: "SNAPSHOT", recordedAt: { gte: dueDate } },
    select: { id: true },
  });
  let cardUpdateId: string | null = null;
  if (!cardSnapshotSince) {
    const latest = await tx.cardBalanceUpdate.findFirstOrThrow({
      where: { cardId: card.id },
      orderBy: { recordedAt: "desc" },
    });
    const update = await tx.cardBalanceUpdate.create({
      data: {
        cardId: card.id,
        totalBalance: Math.max(0, latest.totalBalance - amount),
        statementBalance: Math.max(0, latest.statementBalance - amount),
        reason: `Auto pay (due ${dueLabel(dueDate)})`,
        kind: "PAYMENT",
        recordedAt: now,
      },
    });
    cardUpdateId = update.id;
  }

  let checkingUpdateId: string | null = null;
  if (accountId && !checkingAbsorbs(dueDate)) {
    const latest = await tx.checkingBalanceUpdate.findFirstOrThrow({
      where: { accountId },
      orderBy: { recordedAt: "desc" },
    });
    const update = await tx.checkingBalanceUpdate.create({
      data: {
        accountId,
        balance: latest.balance - amount,
        reason: `Auto pay to ${card.name} (due ${dueLabel(dueDate)})`,
        kind: "SCHEDULED",
        recordedAt: now,
      },
    });
    checkingUpdateId = update.id;
  }

  const outcome: PostingOutcome = cardUpdateId || checkingUpdateId ? "POSTED" : "ABSORBED";
  await tx.scheduledPosting.create({
    data: { ...base, amount, outcome, cardPaymentId: payment.id, cardUpdateId, checkingUpdateId },
  });
  return { kind: "AUTOPAY", label: card.name, dueDate, amount, outcome };
}

/**
 * Carries a corrected bill amount through to the balance when the bill has
 * already been posted: the difference is applied as a fresh checking update.
 * A bill that was absorbed into a balance the user entered is left alone,
 * since that balance is the truth and already reflects the real figure.
 */
export async function repostBillCorrection(
  tx: Tx,
  userId: string,
  expenseId: string,
  dueDate: Date,
  newAmount: number,
  now = new Date()
): Promise<void> {
  const posting = await tx.scheduledPosting.findUnique({
    where: { kind_sourceId_dueDate: { kind: "BILL", sourceId: expenseId, dueDate } },
  });
  if (!posting || posting.userId !== userId || posting.outcome === "ABSORBED") return;

  const oldAmount = posting.outcome === "POSTED" ? posting.amount : 0;
  const delta = newAmount - oldAmount;
  if (delta === 0) return;

  const latest = await tx.checkingBalanceUpdate.findFirst({
    where: { account: { userId } },
    orderBy: { recordedAt: "desc" },
  });
  if (!latest) return;

  await tx.checkingBalanceUpdate.create({
    data: {
      accountId: latest.accountId,
      balance: latest.balance - delta,
      reason: `${posting.label} due ${dueLabel(dueDate)} corrected to ${formatCents(newAmount)}`,
      kind: "SCHEDULED",
      recordedAt: now,
    },
  });
  await tx.scheduledPosting.update({
    where: { id: posting.id },
    data: { amount: newAmount, outcome: newAmount > 0 ? "POSTED" : "NOTHING_DUE" },
  });
}
