"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "./db";
import { checkPassword, createSession, destroySession, requireSession } from "./auth";
import { isAutoPayType } from "./domain";
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
