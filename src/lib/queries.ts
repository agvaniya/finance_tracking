import { prisma } from "./db";
import type {
  CardBalanceUpdate,
  CardPayment,
  CheckingBalanceUpdate,
  CreditCard,
  OneTimeIncome,
} from "@prisma/client";

export interface CardState {
  totalBalance: number;
  statementBalance: number;
  recordedAt: Date;
}

export interface CardWithState {
  card: CreditCard;
  current: CardState | null;
  /** Payments recorded in the current calendar month, in cents. */
  paidThisMonth: number;
}

export async function getCardsWithState(
  userId: string,
  includeArchived = false,
  now = new Date()
): Promise<CardWithState[]> {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [cards, paid] = await Promise.all([
    prisma.creditCard.findMany({
      where: { userId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: { createdAt: "asc" },
      include: { balanceUpdates: { orderBy: { recordedAt: "desc" }, take: 1 } },
    }),
    prisma.cardPayment.groupBy({
      by: ["cardId"],
      where: { card: { userId }, paidAt: { gte: monthStart } },
      _sum: { amount: true },
    }),
  ]);
  const paidByCard = new Map(paid.map((p) => [p.cardId, p._sum.amount ?? 0]));
  return cards.map(({ balanceUpdates, ...card }) => ({
    card: card as CreditCard,
    current: balanceUpdates[0]
      ? {
          totalBalance: balanceUpdates[0].totalBalance,
          statementBalance: balanceUpdates[0].statementBalance,
          recordedAt: balanceUpdates[0].recordedAt,
        }
      : null,
    paidThisMonth: paidByCard.get(card.id) ?? 0,
  }));
}

/** Recorded card payments across the user's active cards, oldest first. */
export async function getCardPayments(userId: string, days?: number): Promise<CardPayment[]> {
  return prisma.cardPayment.findMany({
    where: {
      card: { userId, archivedAt: null },
      ...(days ? { paidAt: { gte: new Date(Date.now() - days * 86_400_000) } } : {}),
    },
    orderBy: { paidAt: "asc" },
  });
}

/** Returns null when the card belongs to someone else, so callers 404. */
export async function getCard(userId: string, cardId: string) {
  return prisma.creditCard.findFirst({
    where: { id: cardId, userId },
    include: {
      balanceUpdates: { orderBy: { recordedAt: "desc" } },
      payments: { orderBy: { paidAt: "desc" } },
    },
  });
}

/** The single checking account, created lazily on first use. */
export async function getCheckingAccount(userId: string) {
  const account = await prisma.checkingAccount.findFirst({
    where: { userId },
    include: { updates: { orderBy: { recordedAt: "desc" }, take: 1 } },
  });
  if (!account) return null;
  const { updates, ...rest } = account;
  return { account: rest, latest: updates[0] ?? null };
}

export async function getIncomes(userId: string, includeInactive = true) {
  return prisma.recurringIncome.findMany({
    where: { account: { userId }, ...(includeInactive ? {} : { active: true }) },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
}

export async function getExpenses(userId: string, includeInactive = true) {
  return prisma.recurringExpense.findMany({
    where: { account: { userId }, ...(includeInactive ? {} : { active: true }) },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
}

/** Corrections from a little before today, so the drift window can use them. */
export async function getExpenseAdjustments(userId: string, sinceDays = 120) {
  return prisma.expenseAdjustment.findMany({
    where: {
      expense: { account: { userId } },
      dueDate: { gte: new Date(Date.now() - sinceDays * 86_400_000) },
    },
  });
}

export interface LastExpense {
  id: string;
  amount: number;
  note: string | null;
  /** "checking" or the card id, matching the record-expense dialog's options. */
  target: string;
  label: string;
  recordedAt: Date;
  /** True while nothing newer has been recorded on the same card or account. */
  editable: boolean;
}

/**
 * The most recent expense on each payment method — every active card and the
 * checking account — with whether it can still be corrected, which is the
 * case only while it is the newest balance record on that method.
 */
export async function getLastExpenses(userId: string): Promise<LastExpense[]> {
  const expenses = await prisma.oneOffExpense.findMany({
    where: { userId, OR: [{ card: { archivedAt: null } }, { cardId: null }] },
    orderBy: { recordedAt: "desc" },
    include: { card: { select: { name: true } }, account: { select: { name: true } } },
  });

  // Newest first, so the first one seen per method is its latest.
  const latestByMethod = new Map<string, (typeof expenses)[number]>();
  for (const e of expenses) {
    const key = e.cardId ?? "checking";
    if (!latestByMethod.has(key)) latestByMethod.set(key, e);
  }

  return Promise.all(
    [...latestByMethod.values()].map(async (expense) => {
      let editable = false;
      if (expense.cardId && expense.cardUpdateId) {
        const latest = await prisma.cardBalanceUpdate.findFirst({
          where: { cardId: expense.cardId },
          orderBy: { recordedAt: "desc" },
          select: { id: true },
        });
        editable = latest?.id === expense.cardUpdateId;
      } else if (expense.accountId && expense.checkingUpdateId) {
        const latest = await prisma.checkingBalanceUpdate.findFirst({
          where: { accountId: expense.accountId },
          orderBy: { recordedAt: "desc" },
          select: { id: true },
        });
        editable = latest?.id === expense.checkingUpdateId;
      }
      return {
        id: expense.id,
        amount: expense.amount,
        note: expense.note,
        target: expense.cardId ?? "checking",
        label: expense.card?.name ?? expense.account?.name ?? "Checking account",
        recordedAt: expense.recordedAt,
        editable,
      };
    })
  );
}

/** One-time income entries, newest first, optionally limited to recent days. */
export async function getOneTimeIncomes(userId: string, days?: number): Promise<OneTimeIncome[]> {
  return prisma.oneTimeIncome.findMany({
    where: {
      account: { userId },
      ...(days ? { receivedAt: { gte: new Date(Date.now() - days * 86_400_000) } } : {}),
    },
    orderBy: { receivedAt: "desc" },
  });
}

export async function getCheckingHistory(
  userId: string,
  days?: number
): Promise<CheckingBalanceUpdate[]> {
  return prisma.checkingBalanceUpdate.findMany({
    where: {
      account: { userId },
      ...(days ? { recordedAt: { gte: new Date(Date.now() - days * 86_400_000) } } : {}),
    },
    orderBy: { recordedAt: "asc" },
  });
}

export async function getCardHistories(
  userId: string,
  days?: number
): Promise<Map<string, CardBalanceUpdate[]>> {
  const updates = await prisma.cardBalanceUpdate.findMany({
    where: {
      card: { userId, archivedAt: null },
      ...(days ? { recordedAt: { gte: new Date(Date.now() - days * 86_400_000) } } : {}),
    },
    orderBy: { recordedAt: "asc" },
  });
  const byCard = new Map<string, CardBalanceUpdate[]>();
  for (const u of updates) {
    const list = byCard.get(u.cardId) ?? [];
    list.push(u);
    byCard.set(u.cardId, list);
  }
  return byCard;
}

export interface ActivityItem {
  id: string;
  when: Date;
  kind: "card-update" | "expense" | "card-payment" | "checking-update" | "one-time-income";
  label: string;
  detail: string;
  reason: string | null;
  colorSlot: number | null;
}

/** Merged recent activity across cards and checking, newest first. */
export async function getRecentActivity(userId: string, limit = 12): Promise<ActivityItem[]> {
  const [cardUpdates, payments, checkingUpdates, oneTimeIncomes, expenses] = await Promise.all([
    prisma.cardBalanceUpdate.findMany({
      where: { kind: "SNAPSHOT", card: { userId } },
      orderBy: { recordedAt: "desc" },
      take: limit,
      include: { card: true },
    }),
    prisma.cardPayment.findMany({
      where: { card: { userId } },
      orderBy: { paidAt: "desc" },
      take: limit,
      include: { card: true },
    }),
    prisma.checkingBalanceUpdate.findMany({
      // Updates written by a one-time income or an expense are shown as those.
      where: { account: { userId }, oneTimeIncome: null, oneOffExpense: null },
      orderBy: { recordedAt: "desc" },
      take: limit,
      include: { account: true },
    }),
    prisma.oneTimeIncome.findMany({
      where: { account: { userId } },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.oneOffExpense.findMany({
      where: { userId },
      orderBy: { recordedAt: "desc" },
      take: limit,
      include: { card: { select: { name: true, colorSlot: true } }, account: { select: { name: true } } },
    }),
  ]);

  const items: ActivityItem[] = [
    ...cardUpdates.map((u) => ({
      id: `cu-${u.id}`,
      when: u.recordedAt,
      kind: "card-update" as const,
      label: u.card.name,
      detail: `balance:${u.totalBalance}`,
      reason: u.reason,
      colorSlot: u.card.colorSlot,
    })),
    ...expenses.map((e) => ({
      id: `ex-${e.id}`,
      when: e.recordedAt,
      kind: "expense" as const,
      label: e.card?.name ?? e.account?.name ?? "Checking account",
      detail: `expense:${e.amount}`,
      reason: e.note,
      colorSlot: e.card?.colorSlot ?? null,
    })),
    ...payments.map((p) => ({
      id: `cp-${p.id}`,
      when: p.paidAt,
      kind: "card-payment" as const,
      label: p.card.name,
      detail: `payment:${p.amount}`,
      reason: p.note,
      colorSlot: p.card.colorSlot,
    })),
    ...checkingUpdates.map((u) => ({
      id: `ck-${u.id}`,
      when: u.recordedAt,
      kind: "checking-update" as const,
      label: u.account.name,
      detail: `balance:${u.balance}`,
      reason: u.reason,
      colorSlot: null,
    })),
    ...oneTimeIncomes.map((i) => ({
      id: `oi-${i.id}`,
      when: i.createdAt,
      kind: "one-time-income" as const,
      label: i.name,
      detail: `income:${i.amount}`,
      reason: i.note,
      colorSlot: null,
    })),
  ];
  items.sort((a, b) => b.when.getTime() - a.when.getTime());
  return items.slice(0, limit);
}
