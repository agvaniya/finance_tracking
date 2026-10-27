"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "./db";
import { requireUserId } from "./auth";
import {
  ONE_TIME_INCOME_LABELS,
  isAutoPayType,
  isOneTimeIncomeCategory,
  isScheduleFrequency,
  usesDayOfMonth,
} from "./domain";
import { parseDollarsToCents } from "./money";

export interface ActionState {
  ok?: boolean;
  error?: string;
}

// Ownership helpers. Every action that names a record by id must prove the
// signed-in user owns it before reading or writing, otherwise a guessed id
// would reach another account's data.

async function assertOwnsCard(userId: string, cardId: string): Promise<void> {
  const card = await prisma.creditCard.findFirst({ where: { id: cardId, userId }, select: { id: true } });
  if (!card) throw new Error("Card not found");
}

async function assertOwnsIncome(userId: string, incomeId: string): Promise<void> {
  const income = await prisma.recurringIncome.findFirst({
    where: { id: incomeId, account: { userId } },
    select: { id: true },
  });
  if (!income) throw new Error("Income not found");
}

async function assertOwnsExpense(userId: string, expenseId: string): Promise<void> {
  const expense = await prisma.recurringExpense.findFirst({
    where: { id: expenseId, account: { userId } },
    select: { id: true },
  });
  if (!expense) throw new Error("Expense not found");
}

// ---------- helpers ----------

function cents(formData: FormData, field: string): number | null {
  const raw = String(formData.get(field) ?? "").trim();
  if (raw === "") return null;
  return parseDollarsToCents(raw);
}

function text(formData: FormData, field: string): string | null {
  const raw = String(formData.get(field) ?? "").trim();
  return raw === "" ? null : raw;
}

function revalidateAll() {
  revalidatePath("/", "layout");
}

// ---------- credit cards ----------

function parseCardFields(formData: FormData): { error?: string; data?: {
  name: string; issuer: string | null; lastFour: string | null; creditLimit: number;
  autoPayDay: number | null; autoPayType: string; autoPayFixedAmount: number | null;
  minimumPayment: number;
} } {
  const name = text(formData, "name");
  if (!name) return { error: "Give the card a name." };

  const creditLimit = cents(formData, "creditLimit");
  if (creditLimit == null || creditLimit <= 0) return { error: "Enter a credit limit above $0." };

  const lastFour = text(formData, "lastFour");
  if (lastFour && !/^\d{4}$/.test(lastFour)) return { error: "Last four digits must be exactly 4 numbers." };

  const autoPayType = String(formData.get("autoPayType") ?? "NONE");
  if (!isAutoPayType(autoPayType)) return { error: "Choose a valid auto pay type." };

  let autoPayDay: number | null = null;
  if (autoPayType !== "NONE") {
    const raw = Number(formData.get("autoPayDay"));
    if (!Number.isInteger(raw) || raw < 1 || raw > 31) {
      return { error: "Auto pay day must be between 1 and 31." };
    }
    autoPayDay = raw;
  }

  let autoPayFixedAmount: number | null = null;
  if (autoPayType === "FIXED") {
    autoPayFixedAmount = cents(formData, "autoPayFixedAmount");
    if (autoPayFixedAmount == null || autoPayFixedAmount <= 0) {
      return { error: "Enter the fixed auto pay amount." };
    }
  }

  const minimumPayment = cents(formData, "minimumPayment") ?? 3_500;
  if (minimumPayment < 0) return { error: "Minimum payment can't be negative." };

  return {
    data: {
      name,
      issuer: text(formData, "issuer"),
      lastFour,
      creditLimit,
      autoPayDay,
      autoPayType,
      autoPayFixedAmount,
      minimumPayment,
    },
  };
}

export async function createCard(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = parseCardFields(formData);
  if (parsed.error || !parsed.data) return { error: parsed.error };

  const initialBalance = cents(formData, "initialBalance");
  const initialStatement = cents(formData, "initialStatement") ?? 0;

  const count = await prisma.creditCard.count({ where: { userId } });
  await prisma.creditCard.create({
    data: {
      ...parsed.data,
      userId,
      colorSlot: count % 8,
      balanceUpdates:
        initialBalance != null
          ? {
              create: {
                totalBalance: initialBalance,
                statementBalance: Math.min(initialStatement, initialBalance),
                reason: "Initial balance entered",
                kind: "SNAPSHOT",
              },
            }
          : undefined,
    },
  });
  revalidateAll();
  return { ok: true };
}

export async function updateCard(cardId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  await assertOwnsCard(userId, cardId);
  const parsed = parseCardFields(formData);
  if (parsed.error || !parsed.data) return { error: parsed.error };
  await prisma.creditCard.update({ where: { id: cardId }, data: parsed.data });
  revalidateAll();
  return { ok: true };
}

export async function archiveCard(cardId: string): Promise<void> {
  const userId = await requireUserId();
  await assertOwnsCard(userId, cardId);
  await prisma.creditCard.update({ where: { id: cardId }, data: { archivedAt: new Date() } });
  revalidateAll();
  redirect("/cards");
}

export async function recordCardBalance(cardId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  await assertOwnsCard(userId, cardId);
  const total = cents(formData, "totalBalance");
  if (total == null || total < 0) return { error: "Enter the current total balance." };
  const statement = cents(formData, "statementBalance");
  if (statement == null || statement < 0) return { error: "Enter the last month (statement) balance — 0 if nothing is due." };
  if (statement > total) return { error: "The statement balance can't exceed the total balance." };

  await prisma.cardBalanceUpdate.create({
    data: {
      cardId,
      totalBalance: total,
      statementBalance: statement,
      reason: text(formData, "reason"),
      kind: "SNAPSHOT",
    },
  });
  revalidateAll();
  return { ok: true };
}

export async function recordPayment(cardId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  await assertOwnsCard(userId, cardId);
  const amount = cents(formData, "amount");
  if (amount == null || amount <= 0) return { error: "Enter a payment amount above $0." };
  const note = text(formData, "note");
  const deductFromChecking = formData.get("deductFromChecking") === "on";

  const latest = await prisma.cardBalanceUpdate.findFirst({
    where: { cardId },
    orderBy: { recordedAt: "desc" },
  });
  if (!latest) return { error: "Record the card's balance once before logging payments." };
  if (amount > latest.totalBalance) {
    return { error: "That payment is larger than the card's current balance." };
  }

  await prisma.$transaction(async (tx) => {
    const card = await tx.creditCard.findUniqueOrThrow({ where: { id: cardId } });
    await tx.cardPayment.create({ data: { cardId, amount, note } });
    await tx.cardBalanceUpdate.create({
      data: {
        cardId,
        totalBalance: latest.totalBalance - amount,
        statementBalance: Math.max(0, latest.statementBalance - amount),
        reason: note ?? "Payment recorded",
        kind: "PAYMENT",
      },
    });
    if (deductFromChecking) {
      const account = await tx.checkingAccount.findFirst({
        where: { userId },
        include: { updates: { orderBy: { recordedAt: "desc" }, take: 1 } },
      });
      if (account && account.updates[0]) {
        await tx.checkingBalanceUpdate.create({
          data: {
            accountId: account.id,
            balance: account.updates[0].balance - amount,
            reason: `Payment to ${card.name}`,
          },
        });
      }
    }
  });
  revalidateAll();
  return { ok: true };
}

// ---------- expenses (one-off, on a card or from checking) ----------

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Writes the balance movement for an expense and returns the ids of the
 * update it wrote, so the expense row can point at it. Throws a user-facing
 * message when the target has no balance to move.
 */
async function applyExpense(
  tx: Tx,
  userId: string,
  target: string,
  amount: number,
  note: string | null
): Promise<{ cardId: string | null; accountId: string | null; cardUpdateId: string | null; checkingUpdateId: string | null }> {
  if (target === "checking") {
    const account = await tx.checkingAccount.findFirst({
      where: { userId },
      include: { updates: { orderBy: { recordedAt: "desc" }, take: 1 } },
    });
    if (!account || !account.updates[0]) {
      throw new Error("Record the checking balance once before logging expenses.");
    }
    const update = await tx.checkingBalanceUpdate.create({
      data: {
        accountId: account.id,
        balance: account.updates[0].balance - amount,
        reason: note ? `Expense: ${note}` : "Expense",
      },
    });
    return { cardId: null, accountId: account.id, cardUpdateId: null, checkingUpdateId: update.id };
  }

  const card = await tx.creditCard.findFirst({
    where: { id: target, userId, archivedAt: null },
    include: { balanceUpdates: { orderBy: { recordedAt: "desc" }, take: 1 } },
  });
  if (!card) throw new Error("That card was not found.");
  const latest = card.balanceUpdates[0];
  if (!latest) throw new Error(`Record ${card.name}'s balance once before logging expenses on it.`);
  const update = await tx.cardBalanceUpdate.create({
    data: {
      cardId: card.id,
      totalBalance: latest.totalBalance + amount,
      statementBalance: latest.statementBalance,
      reason: note ?? "Expense",
      kind: "CHARGE",
    },
  });
  return { cardId: card.id, accountId: null, cardUpdateId: update.id, checkingUpdateId: null };
}

function parseExpenseEntry(formData: FormData): { error?: string; amount: number; note: string | null; target: string } {
  const amount = cents(formData, "amount");
  const note = text(formData, "note");
  const target = String(formData.get("target") ?? "");
  if (amount == null || amount <= 0) return { error: "Enter the amount spent, above $0.", amount: 0, note, target };
  if (!target) return { error: "Choose where the expense was paid from.", amount, note, target };
  return { amount, note, target };
}

/**
 * A purchase or bill paid just now. On a card it raises the outstanding
 * total (a CHARGE update, which the forecast reads as card spending); from
 * checking it lowers the balance directly.
 */
export async function recordExpense(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = parseExpenseEntry(formData);
  if (parsed.error) return { error: parsed.error };

  try {
    await prisma.$transaction(async (tx) => {
      const links = await applyExpense(tx, userId, parsed.target, parsed.amount, parsed.note);
      await tx.oneOffExpense.create({ data: { userId, amount: parsed.amount, note: parsed.note, ...links } });
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not record the expense." };
  }
  revalidateAll();
  return { ok: true };
}

/**
 * Whether the balance update an expense wrote is still the newest on its
 * card or account. Only then can the expense be changed or removed without
 * contradicting something recorded afterwards.
 */
async function expenseIsLatest(
  tx: Tx,
  expense: { cardId: string | null; accountId: string | null; cardUpdateId: string | null; checkingUpdateId: string | null }
): Promise<boolean> {
  if (expense.cardId && expense.cardUpdateId) {
    const latest = await tx.cardBalanceUpdate.findFirst({
      where: { cardId: expense.cardId },
      orderBy: { recordedAt: "desc" },
      select: { id: true },
    });
    return latest?.id === expense.cardUpdateId;
  }
  if (expense.accountId && expense.checkingUpdateId) {
    const latest = await tx.checkingBalanceUpdate.findFirst({
      where: { accountId: expense.accountId },
      orderBy: { recordedAt: "desc" },
      select: { id: true },
    });
    return latest?.id === expense.checkingUpdateId;
  }
  return false;
}

const NOT_LATEST =
  "Something has been recorded since this expense, so it can't be changed here. Update the balance directly instead.";

/** Removes the balance update an expense wrote. Caller has checked it is the latest. */
async function revertExpense(
  tx: Tx,
  expense: { cardUpdateId: string | null; checkingUpdateId: string | null }
): Promise<void> {
  if (expense.cardUpdateId) await tx.cardBalanceUpdate.delete({ where: { id: expense.cardUpdateId } });
  if (expense.checkingUpdateId) await tx.checkingBalanceUpdate.delete({ where: { id: expense.checkingUpdateId } });
}

/**
 * Corrects a recorded expense: the original balance movement is taken back
 * and a fresh one written for the new amount, target and comment. Allowed
 * only while the original is still the latest record on its card or account.
 */
export async function updateExpenseRecord(expenseId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = parseExpenseEntry(formData);
  if (parsed.error) return { error: parsed.error };

  try {
    await prisma.$transaction(async (tx) => {
      const expense = await tx.oneOffExpense.findFirst({ where: { id: expenseId, userId } });
      if (!expense) throw new Error("Expense not found.");
      if (!(await expenseIsLatest(tx, expense))) throw new Error(NOT_LATEST);
      await revertExpense(tx, expense);
      const links = await applyExpense(tx, userId, parsed.target, parsed.amount, parsed.note);
      await tx.oneOffExpense.update({
        where: { id: expense.id },
        data: { amount: parsed.amount, note: parsed.note, ...links },
      });
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not update the expense." };
  }
  revalidateAll();
  return { ok: true };
}

/** Removes a recorded expense and the balance movement it made, if still the latest. */
export async function deleteExpenseRecord(expenseId: string): Promise<ActionState> {
  const userId = await requireUserId();
  try {
    await prisma.$transaction(async (tx) => {
      const expense = await tx.oneOffExpense.findFirst({ where: { id: expenseId, userId } });
      if (!expense) throw new Error("Expense not found.");
      if (!(await expenseIsLatest(tx, expense))) throw new Error(NOT_LATEST);
      await revertExpense(tx, expense);
      await tx.oneOffExpense.delete({ where: { id: expense.id } });
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not remove the expense." };
  }
  revalidateAll();
  return { ok: true };
}

// ---------- checking ----------

export async function updateChecking(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  const balance = cents(formData, "balance");
  if (balance == null) return { error: "Enter the current checking balance." };

  let account = await prisma.checkingAccount.findFirst({ where: { userId } });
  if (!account) {
    account = await prisma.checkingAccount.create({ data: { userId } });
  }
  await prisma.checkingBalanceUpdate.create({
    data: { accountId: account.id, balance, reason: text(formData, "reason") },
  });
  revalidateAll();
  return { ok: true };
}

// ---------- one-time income ----------

/**
 * Money that arrived once: a transfer from savings, a gift, a reimbursement.
 * Raises the checking balance in the same transaction, and keeps a record so
 * the forecast knows the jump is not everyday income.
 */
export async function recordOneTimeIncome(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();

  const amount = cents(formData, "amount");
  if (amount == null || amount <= 0) return { error: "Enter the amount received, above $0." };

  const category = String(formData.get("category") ?? "OTHER");
  if (!isOneTimeIncomeCategory(category)) return { error: "Choose what kind of income this is." };

  const name = text(formData, "name") ?? ONE_TIME_INCOME_LABELS[category];

  const rawDate = text(formData, "receivedAt");
  const receivedAt = rawDate ? new Date(`${rawDate}T00:00:00`) : new Date(new Date().setHours(0, 0, 0, 0));
  if (Number.isNaN(receivedAt.getTime())) return { error: "That date is not valid." };
  if (receivedAt.getTime() > Date.now()) return { error: "The date can't be in the future — record it once it arrives." };

  const account = await prisma.checkingAccount.findFirst({
    where: { userId },
    include: { updates: { orderBy: { recordedAt: "desc" }, take: 1 } },
  });
  if (!account || !account.updates[0]) {
    return { error: "Record the checking balance once before logging income." };
  }

  await prisma.$transaction(async (tx) => {
    const update = await tx.checkingBalanceUpdate.create({
      data: {
        accountId: account.id,
        balance: account.updates[0].balance + amount,
        reason: `${ONE_TIME_INCOME_LABELS[category]}: ${name}`,
      },
    });
    await tx.oneTimeIncome.create({
      data: {
        accountId: account.id,
        name,
        amount,
        category,
        note: text(formData, "note"),
        receivedAt,
        balanceUpdateId: update.id,
      },
    });
  });
  revalidateAll();
  return { ok: true };
}

/**
 * Removes a one-time income. If the balance update it wrote is still the
 * latest one, that update goes too, so the balance returns to what it was;
 * anything recorded since is newer truth and is left alone.
 */
export async function removeOneTimeIncome(incomeId: string): Promise<void> {
  const userId = await requireUserId();
  const income = await prisma.oneTimeIncome.findFirst({
    where: { id: incomeId, account: { userId } },
    include: { account: { include: { updates: { orderBy: { recordedAt: "desc" }, take: 1 } } } },
  });
  if (!income) throw new Error("Income not found");

  await prisma.$transaction(async (tx) => {
    await tx.oneTimeIncome.delete({ where: { id: income.id } });
    const latest = income.account.updates[0];
    if (income.balanceUpdateId && latest && latest.id === income.balanceUpdateId) {
      await tx.checkingBalanceUpdate.delete({ where: { id: latest.id } });
    }
  });
  revalidateAll();
}

// ---------- recurring income ----------

function parseIncomeFields(formData: FormData): { error?: string; data?: {
  name: string; amount: number; frequency: string;
  dayOfMonth: number | null; secondDayOfMonth: number | null; anchorDate: Date | null;
  startDate: Date | null;
} } {
  const name = text(formData, "name");
  if (!name) return { error: "Name this income, e.g. the employer." };

  const amount = cents(formData, "amount");
  if (amount == null || amount <= 0) return { error: "Enter the amount received each time, above $0." };

  const frequency = String(formData.get("frequency") ?? "");
  if (!isScheduleFrequency(frequency)) return { error: "Choose how often it arrives." };

  let dayOfMonth: number | null = null;
  let secondDayOfMonth: number | null = null;
  let anchorDate: Date | null = null;

  if (usesDayOfMonth(frequency)) {
    const first = Number(formData.get("dayOfMonth"));
    if (!Number.isInteger(first) || first < 1 || first > 31) {
      return { error: "Pay day must be between 1 and 31." };
    }
    dayOfMonth = first;

    if (frequency === "SEMI_MONTHLY") {
      const second = Number(formData.get("secondDayOfMonth"));
      if (!Number.isInteger(second) || second < 1 || second > 31) {
        return { error: "Enter both pay days, each between 1 and 31." };
      }
      if (second === first) return { error: "The two pay days must differ." };
      secondDayOfMonth = second;
    }
  } else {
    const raw = text(formData, "anchorDate");
    if (!raw) return { error: "Pick a recent pay date so the cycle can be anchored." };
    const parsed = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return { error: "That pay date is not a valid date." };
    anchorDate = parsed;
  }

  // Optional: only for a schedule that has not started yet, so the forecast
  // neither projects it early nor reads it into past balances.
  let startDate: Date | null = null;
  const rawStart = text(formData, "startDate");
  if (rawStart) {
    startDate = new Date(`${rawStart}T00:00:00`);
    if (Number.isNaN(startDate.getTime())) return { error: "That first date is not a valid date." };
  }

  return { data: { name, amount, frequency, dayOfMonth, secondDayOfMonth, anchorDate, startDate } };
}

/** The checking account is created lazily, so income can be set up first. */
async function checkingAccountId(userId: string): Promise<string> {
  const existing = await prisma.checkingAccount.findFirst({ where: { userId } });
  if (existing) return existing.id;
  const created = await prisma.checkingAccount.create({ data: { userId } });
  return created.id;
}

export async function createIncome(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = parseIncomeFields(formData);
  if (parsed.error || !parsed.data) return { error: parsed.error };

  await prisma.recurringIncome.create({
    data: { ...parsed.data, accountId: await checkingAccountId(userId) },
  });
  revalidateAll();
  return { ok: true };
}

export async function updateIncome(incomeId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  await assertOwnsIncome(userId, incomeId);
  const parsed = parseIncomeFields(formData);
  if (parsed.error || !parsed.data) return { error: parsed.error };

  await prisma.recurringIncome.update({ where: { id: incomeId }, data: parsed.data });
  revalidateAll();
  return { ok: true };
}

/**
 * Pausing keeps the history meaningful; deleting would rewrite the past. The
 * pause time lets the forecast keep crediting the schedule for history up to
 * that point.
 */
export async function setIncomeActive(incomeId: string, active: boolean): Promise<void> {
  const userId = await requireUserId();
  await assertOwnsIncome(userId, incomeId);
  await prisma.recurringIncome.update({
    where: { id: incomeId },
    data: { active, pausedAt: active ? null : new Date() },
  });
  revalidateAll();
}

export async function deleteIncome(incomeId: string): Promise<void> {
  const userId = await requireUserId();
  await assertOwnsIncome(userId, incomeId);
  await prisma.recurringIncome.delete({ where: { id: incomeId } });
  revalidateAll();
}

// ---------- recurring expenses ----------

function parseExpenseFields(formData: FormData): { error?: string; data?: {
  name: string; amount: number; estimated: boolean; frequency: string;
  dayOfMonth: number | null; secondDayOfMonth: number | null; anchorDate: Date | null;
  startDate: Date | null;
} } {
  // The schedule half is identical to income, so reuse that parser and layer
  // the expense-only fields on top.
  const schedule = parseIncomeFields(formData);
  if (schedule.error || !schedule.data) return { error: schedule.error };

  return {
    data: {
      ...schedule.data,
      estimated: formData.get("estimated") === "on",
    },
  };
}

export async function createExpense(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = parseExpenseFields(formData);
  if (parsed.error || !parsed.data) return { error: parsed.error };

  await prisma.recurringExpense.create({
    data: { ...parsed.data, accountId: await checkingAccountId(userId) },
  });
  revalidateAll();
  return { ok: true };
}

export async function updateExpense(expenseId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  await assertOwnsExpense(userId, expenseId);
  const parsed = parseExpenseFields(formData);
  if (parsed.error || !parsed.data) return { error: parsed.error };

  await prisma.recurringExpense.update({ where: { id: expenseId }, data: parsed.data });
  revalidateAll();
  return { ok: true };
}

export async function setExpenseActive(expenseId: string, active: boolean): Promise<void> {
  const userId = await requireUserId();
  await assertOwnsExpense(userId, expenseId);
  await prisma.recurringExpense.update({
    where: { id: expenseId },
    data: { active, pausedAt: active ? null : new Date() },
  });
  revalidateAll();
}

export async function deleteExpense(expenseId: string): Promise<void> {
  const userId = await requireUserId();
  await assertOwnsExpense(userId, expenseId);
  await prisma.recurringExpense.delete({ where: { id: expenseId } });
  revalidateAll();
}

/**
 * Replace the expected amount for a single due date — the actual bill, once
 * it arrives. Entering 0 means it will not be charged that time.
 */
export async function adjustBill(
  expenseId: string,
  dueDateISO: string,
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const userId = await requireUserId();
  await assertOwnsExpense(userId, expenseId);

  const amount = cents(formData, "amount");
  if (amount == null || amount < 0) {
    return { error: "Enter the actual amount — 0 if it will not be charged." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDateISO)) return { error: "That due date is not valid." };
  const dueDate = new Date(`${dueDateISO}T00:00:00`);

  await prisma.expenseAdjustment.upsert({
    where: { expenseId_dueDate: { expenseId, dueDate } },
    create: { expenseId, dueDate, amount, note: text(formData, "note") },
    update: { amount, note: text(formData, "note") },
  });
  revalidateAll();
  return { ok: true };
}

/** Drop a correction so the occurrence falls back to the scheduled estimate. */
export async function clearBillAdjustment(expenseId: string, dueDateISO: string): Promise<void> {
  const userId = await requireUserId();
  await assertOwnsExpense(userId, expenseId);
  const dueDate = new Date(`${dueDateISO}T00:00:00`);
  await prisma.expenseAdjustment.deleteMany({ where: { expenseId, dueDate } });
  revalidateAll();
}

export async function renameChecking(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  const name = text(formData, "name");
  if (!name) return { error: "Enter an account name." };
  const account = await prisma.checkingAccount.findFirst({ where: { userId } });
  if (account) {
    await prisma.checkingAccount.update({ where: { id: account.id }, data: { name } });
  } else {
    await prisma.checkingAccount.create({ data: { name, userId } });
  }
  revalidateAll();
  return { ok: true };
}
