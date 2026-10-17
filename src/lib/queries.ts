import { prisma } from "./db";
import type { CardBalanceUpdate, CheckingBalanceUpdate, CreditCard } from "@prisma/client";

export interface CardState {
  totalBalance: number;
  statementBalance: number;
  recordedAt: Date;
}

export interface CardWithState {
  card: CreditCard;
  current: CardState | null;
}

export async function getCardsWithState(includeArchived = false): Promise<CardWithState[]> {
  const cards = await prisma.creditCard.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    orderBy: { createdAt: "asc" },
    include: { balanceUpdates: { orderBy: { recordedAt: "desc" }, take: 1 } },
  });
  return cards.map(({ balanceUpdates, ...card }) => ({
    card: card as CreditCard,
    current: balanceUpdates[0]
      ? {
          totalBalance: balanceUpdates[0].totalBalance,
          statementBalance: balanceUpdates[0].statementBalance,
          recordedAt: balanceUpdates[0].recordedAt,
        }
      : null,
  }));
}

export async function getCard(cardId: string) {
  return prisma.creditCard.findUnique({
    where: { id: cardId },
    include: {
      balanceUpdates: { orderBy: { recordedAt: "desc" } },
      payments: { orderBy: { paidAt: "desc" } },
    },
  });
}

/** The single checking account, created lazily on first use. */
export async function getCheckingAccount() {
  const account = await prisma.checkingAccount.findFirst({
    include: { updates: { orderBy: { recordedAt: "desc" }, take: 1 } },
  });
  if (!account) return null;
  const { updates, ...rest } = account;
  return { account: rest, latest: updates[0] ?? null };
}

export async function getIncomes(includeInactive = true) {
  const account = await prisma.checkingAccount.findFirst();
  if (!account) return [];
  return prisma.recurringIncome.findMany({
    where: { accountId: account.id, ...(includeInactive ? {} : { active: true }) },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
}

export async function getExpenses(includeInactive = true) {
  const account = await prisma.checkingAccount.findFirst();
  if (!account) return [];
  return prisma.recurringExpense.findMany({
    where: { accountId: account.id, ...(includeInactive ? {} : { active: true }) },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
}

/** Corrections from a little before today, so the drift window can use them. */
export async function getExpenseAdjustments(sinceDays = 120) {
  return prisma.expenseAdjustment.findMany({
    where: { dueDate: { gte: new Date(Date.now() - sinceDays * 86_400_000) } },
  });
}

export async function getCheckingHistory(days?: number): Promise<CheckingBalanceUpdate[]> {
  const account = await prisma.checkingAccount.findFirst();
  if (!account) return [];
  return prisma.checkingBalanceUpdate.findMany({
    where: {
      accountId: account.id,
      ...(days ? { recordedAt: { gte: new Date(Date.now() - days * 86_400_000) } } : {}),
    },
    orderBy: { recordedAt: "asc" },
  });
}

export async function getCardHistories(days?: number): Promise<Map<string, CardBalanceUpdate[]>> {
  const updates = await prisma.cardBalanceUpdate.findMany({
    where: {
      card: { archivedAt: null },
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
  kind: "card-update" | "card-payment" | "checking-update";
  label: string;
  detail: string;
  reason: string | null;
  colorSlot: number | null;
}

/** Merged recent activity across cards and checking, newest first. */
export async function getRecentActivity(limit = 12): Promise<ActivityItem[]> {
  const [cardUpdates, payments, checkingUpdates] = await Promise.all([
    prisma.cardBalanceUpdate.findMany({
      where: { kind: "SNAPSHOT" },
      orderBy: { recordedAt: "desc" },
      take: limit,
      include: { card: true },
    }),
    prisma.cardPayment.findMany({
      orderBy: { paidAt: "desc" },
      take: limit,
      include: { card: true },
    }),
    prisma.checkingBalanceUpdate.findMany({
      orderBy: { recordedAt: "desc" },
      take: limit,
      include: { account: true },
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
  ];
  items.sort((a, b) => b.when.getTime() - a.when.getTime());
  return items.slice(0, limit);
}
