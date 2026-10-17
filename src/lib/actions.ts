"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "./db";
import { checkPassword, createSession, destroySession, requireSession } from "./auth";
import { isAutoPayType, isScheduleFrequency, usesDayOfMonth } from "./domain";
import { parseDollarsToCents } from "./money";

export interface ActionState {
  ok?: boolean;
  error?: string;
}

// ---------- auth ----------

export async function login(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const password = String(formData.get("password") ?? "");
  if (!checkPassword(password)) {
    return { error: "That password is not correct." };
  }
  await createSession();
  redirect("/");
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect("/login");
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
  await requireSession();
  const parsed = parseCardFields(formData);
  if (parsed.error || !parsed.data) return { error: parsed.error };

  const initialBalance = cents(formData, "initialBalance");
  const initialStatement = cents(formData, "initialStatement") ?? 0;

  const count = await prisma.creditCard.count();
  await prisma.creditCard.create({
    data: {
      ...parsed.data,
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
  await requireSession();
  const parsed = parseCardFields(formData);
  if (parsed.error || !parsed.data) return { error: parsed.error };
  await prisma.creditCard.update({ where: { id: cardId }, data: parsed.data });
  revalidateAll();
  return { ok: true };
}

export async function archiveCard(cardId: string): Promise<void> {
  await requireSession();
  await prisma.creditCard.update({ where: { id: cardId }, data: { archivedAt: new Date() } });
  revalidateAll();
  redirect("/cards");
}

export async function recordCardBalance(cardId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();
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
  await requireSession();
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

// ---------- checking ----------

export async function updateChecking(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();
  const balance = cents(formData, "balance");
  if (balance == null) return { error: "Enter the current checking balance." };

  let account = await prisma.checkingAccount.findFirst();
  if (!account) {
    account = await prisma.checkingAccount.create({ data: {} });
  }
  await prisma.checkingBalanceUpdate.create({
    data: { accountId: account.id, balance, reason: text(formData, "reason") },
  });
  revalidateAll();
  return { ok: true };
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
async function checkingAccountId(): Promise<string> {
  const existing = await prisma.checkingAccount.findFirst();
  if (existing) return existing.id;
  const created = await prisma.checkingAccount.create({ data: {} });
  return created.id;
}

export async function createIncome(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();
  const parsed = parseIncomeFields(formData);
  if (parsed.error || !parsed.data) return { error: parsed.error };

  await prisma.recurringIncome.create({
    data: { ...parsed.data, accountId: await checkingAccountId() },
  });
  revalidateAll();
  return { ok: true };
}

export async function updateIncome(incomeId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();
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
  await requireSession();
  await prisma.recurringIncome.update({
    where: { id: incomeId },
    data: { active, pausedAt: active ? null : new Date() },
  });
  revalidateAll();
}

export async function deleteIncome(incomeId: string): Promise<void> {
  await requireSession();
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
  await requireSession();
  const parsed = parseExpenseFields(formData);
  if (parsed.error || !parsed.data) return { error: parsed.error };

  await prisma.recurringExpense.create({
    data: { ...parsed.data, accountId: await checkingAccountId() },
  });
  revalidateAll();
  return { ok: true };
}

export async function updateExpense(expenseId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();
  const parsed = parseExpenseFields(formData);
  if (parsed.error || !parsed.data) return { error: parsed.error };

  await prisma.recurringExpense.update({ where: { id: expenseId }, data: parsed.data });
  revalidateAll();
  return { ok: true };
}

export async function setExpenseActive(expenseId: string, active: boolean): Promise<void> {
  await requireSession();
  await prisma.recurringExpense.update({
    where: { id: expenseId },
    data: { active, pausedAt: active ? null : new Date() },
  });
  revalidateAll();
}

export async function deleteExpense(expenseId: string): Promise<void> {
  await requireSession();
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
  await requireSession();

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
  await requireSession();
  const dueDate = new Date(`${dueDateISO}T00:00:00`);
  await prisma.expenseAdjustment.deleteMany({ where: { expenseId, dueDate } });
  revalidateAll();
}

export async function renameChecking(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();
  const name = text(formData, "name");
  if (!name) return { error: "Enter an account name." };
  const account = await prisma.checkingAccount.findFirst();
  if (account) {
    await prisma.checkingAccount.update({ where: { id: account.id }, data: { name } });
  } else {
    await prisma.checkingAccount.create({ data: { name } });
  }
  revalidateAll();
  return { ok: true };
}
