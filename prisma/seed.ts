/**
 * Seeds ~3.5 months of realistic demo history so charts, the calendar, and
 * predictions are populated on first run. Deterministic (seeded PRNG), and
 * skipped automatically if the database already has data.
 *
 * Run with: npm run db:seed
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Small deterministic PRNG (mulberry32) so reseeding produces identical data.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261015);
const randInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;

const DAY = 24 * 60 * 60 * 1000;
const at = (d: Date, hour: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, randInt(0, 59));

async function main() {
  const existing = await prisma.creditCard.count();
  if (existing > 0 || (await prisma.checkingAccount.count()) > 0) {
    console.log("Database already has data — skipping seed.");
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today.getTime() - 105 * DAY);

  // ---- Checking account -------------------------------------------------
  const account = await prisma.checkingAccount.create({
    data: { name: "Everyday Checking", createdAt: start },
  });

  let checking = 420_000; // $4,200.00
  const checkingUpdates: { balance: number; reason: string; recordedAt: Date }[] = [
    { balance: checking, reason: "Opening balance", recordedAt: at(start, 9) },
  ];
  let lastSpendLog = start.getTime();

  for (let t = start.getTime() + DAY; t <= today.getTime(); t += DAY) {
    const d = new Date(t);
    const dom = d.getDate();
    if (dom === 1 || dom === 15) {
      checking += 340_000;
      checkingUpdates.push({ balance: checking, reason: "Salary deposited", recordedAt: at(d, 8) });
    }
    if (dom === 2) {
      checking -= 210_000;
      checkingUpdates.push({ balance: checking, reason: "Rent payment", recordedAt: at(d, 10) });
    }
    // Log accumulated everyday spending every ~6 days.
    if (t - lastSpendLog >= 6 * DAY) {
      checking -= randInt(14_000, 36_000);
      checkingUpdates.push({
        balance: checking,
        reason: "Groceries and everyday spending",
        recordedAt: at(d, 19),
      });
      lastSpendLog = t;
    }
  }
  // A couple of one-off events with user-entered reasons.
  const giftDay = new Date(start.getTime() + 50 * DAY);
  checkingUpdates.push({ balance: (checking += 20_000), reason: "Gift received", recordedAt: at(giftDay, 12) });
  const refundDay = new Date(start.getTime() + 70 * DAY);
  checkingUpdates.push({ balance: (checking += 45_000), reason: "Refund issued from insurance", recordedAt: at(refundDay, 14) });
  checkingUpdates.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  // Rebuild running balance after sorting one-offs into place.
  let running = 420_000;
  for (const u of checkingUpdates) {
    if (u.reason === "Opening balance") continue;
    if (u.reason === "Salary deposited") running += 340_000;
    else if (u.reason === "Rent payment") running -= 210_000;
    else if (u.reason === "Gift received") running += 20_000;
    else if (u.reason === "Refund issued from insurance") running += 45_000;
    else running -= randInt(14_000, 36_000);
    u.balance = running;
  }
  await prisma.checkingBalanceUpdate.createMany({
    data: checkingUpdates.map((u) => ({ ...u, accountId: account.id })),
  });

  // ---- Credit cards ------------------------------------------------------
  const cardSpecs = [
    {
      name: "Sapphire Preferred", issuer: "Chase", lastFour: "4821",
      creditLimit: 1_200_000, autoPayDay: 7, autoPayType: "STATEMENT",
      autoPayFixedAmount: null as number | null, minimumPayment: 4_000,
      colorSlot: 0, startTotal: 310_000, monthlySpend: [55_000, 95_000] as [number, number],
    },
    {
      name: "Blue Cash Everyday", issuer: "American Express", lastFour: "1007",
      creditLimit: 800_000, autoPayDay: 18, autoPayType: "FIXED",
      autoPayFixedAmount: 30_000, minimumPayment: 3_500,
      colorSlot: 1, startTotal: 240_000, monthlySpend: [30_000, 60_000] as [number, number],
    },
    {
      name: "Quicksilver", issuer: "Capital One", lastFour: "9934",
      creditLimit: 500_000, autoPayDay: 25, autoPayType: "MINIMUM",
      autoPayFixedAmount: null as number | null, minimumPayment: 3_500,
      colorSlot: 2, startTotal: 90_000, monthlySpend: [15_000, 40_000] as [number, number],
    },
  ];

  for (const spec of cardSpecs) {
    const { startTotal, monthlySpend, ...data } = spec;
    const card = await prisma.creditCard.create({ data: { ...data, createdAt: start } });

    let total = startTotal;
    let statement = Math.round(startTotal * 0.8);
    const updates: { totalBalance: number; statementBalance: number; reason: string | null; kind: string; recordedAt: Date }[] = [
      { totalBalance: total, statementBalance: statement, reason: "Initial balance entered", kind: "SNAPSHOT", recordedAt: at(start, 9) },
    ];
    const payments: { amount: number; note: string | null; paidAt: Date }[] = [];
    let lastSnapshot = start.getTime();

    for (let t = start.getTime() + DAY; t <= today.getTime(); t += DAY) {
      const d = new Date(t);
      const dom = d.getDate();

      // Statement closes on the 1st: last month's spending becomes due.
      if (dom === 1) {
        statement = total;
        updates.push({ totalBalance: total, statementBalance: statement, reason: "Statement posted", kind: "SNAPSHOT", recordedAt: at(d, 7) });
      }

      // Auto pay fires on its configured day.
      if (dom === spec.autoPayDay) {
        let amount =
          spec.autoPayType === "STATEMENT" ? statement :
          spec.autoPayType === "FIXED" ? (spec.autoPayFixedAmount ?? 0) :
          spec.minimumPayment;
        amount = Math.max(0, Math.min(amount, total));
        if (amount > 0) {
          total -= amount;
          statement = Math.max(0, statement - amount);
          const when = at(d, 6);
          payments.push({ amount, note: "Auto pay", paidAt: when });
          updates.push({ totalBalance: total, statementBalance: statement, reason: "Auto pay", kind: "PAYMENT", recordedAt: when });
        }
      }

      // Everyday spending accrues; the user records a snapshot every ~8 days.
      total += Math.round(randInt(...monthlySpend) / 30);
      if (total > spec.creditLimit) total = spec.creditLimit;
      if (t - lastSnapshot >= 8 * DAY) {
        updates.push({ totalBalance: total, statementBalance: statement, reason: "Balance check", kind: "SNAPSHOT", recordedAt: at(d, 21) });
        lastSnapshot = t;
      }
    }

    // One manual extra payment mid-history on the first card.
    if (spec.colorSlot === 0) {
      const d = new Date(start.getTime() + 60 * DAY);
      const amount = 50_000;
      const when = at(d, 13);
      total = Math.max(0, total); // keep invariant obvious
      payments.push({ amount, note: "Extra payment from bonus", paidAt: when });
      // Insert a matching derived update at the right point in time.
      const before = updates.filter((u) => u.recordedAt.getTime() <= when.getTime()).at(-1)!;
      updates.push({
        totalBalance: Math.max(0, before.totalBalance - amount),
        statementBalance: Math.max(0, before.statementBalance - amount),
        reason: "Extra payment from bonus",
        kind: "PAYMENT",
        recordedAt: when,
      });
    }

    updates.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
    await prisma.cardBalanceUpdate.createMany({ data: updates.map((u) => ({ ...u, cardId: card.id })) });
    await prisma.cardPayment.createMany({ data: payments.map((p) => ({ ...p, cardId: card.id })) });
    console.log(`Seeded ${spec.name}: ${updates.length} balance updates, ${payments.length} payments.`);
  }

  console.log(`Seeded checking account with ${checkingUpdates.length} updates.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
