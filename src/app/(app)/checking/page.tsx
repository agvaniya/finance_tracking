import { format, formatDistanceToNow } from "date-fns";
import { TrendChart } from "@/components/charts";
import {
  AddExpenseButton,
  AddIncomeButton,
  AdjustBillButton,
  ExpenseRowActions,
  IncomeRowActions,
  RenameCheckingButton,
  UpdateCheckingButton,
} from "@/components/forms";
import { EmptyState, Money, Panel, cx } from "@/components/ui";
import { requireUserId } from "@/lib/auth";
import { sampleDailySeries } from "@/lib/chartData";
import { CHECKING_COLOR } from "@/lib/colors";
import {
  SCHEDULE_FREQUENCY_LABELS,
  monthlyEquivalent,
  nextOccurrenceDate,
  scheduleDateInputs,
  type ScheduleFrequency,
} from "@/lib/domain";
import { formatCents } from "@/lib/money";
import { HISTORY_DAYS, MIN_WINDOW_DAYS, buildForecast } from "@/lib/predictions";
import {
  getCardHistories,
  getCardPayments,
  getCardsWithState,
  getCheckingAccount,
  getCheckingHistory,
  getExpenseAdjustments,
  getExpenses,
  getIncomes,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function CheckingPage() {
  const userId = await requireUserId();
  const [checking, history, cards, incomes, expenses, adjustments, cardHistories, cardPayments] =
    await Promise.all([
      getCheckingAccount(userId),
      getCheckingHistory(userId),
      getCardsWithState(userId),
      getIncomes(userId),
      getExpenses(userId),
      getExpenseAdjustments(userId),
      getCardHistories(userId, HISTORY_DAYS),
      getCardPayments(userId, HISTORY_DAYS),
    ]);

  const forecast = buildForecast({
    checkingHistory: history,
    cards,
    incomes,
    expenses,
    adjustments,
    cardPayments,
    cardUpdates: [...cardHistories.values()].flat(),
  });
  const now = new Date();
  const monthlyIncome = incomes
    .filter((i) => i.active)
    .reduce((sum, i) => sum + monthlyEquivalent(i), 0);
  const monthlyExpense = expenses
    .filter((e) => e.active)
    .reduce((sum, e) => sum + monthlyEquivalent(e), 0);

  const rows = sampleDailySeries(
    { balance: history.map((u) => ({ t: u.recordedAt.getTime(), v: u.balance })) },
    120
  );
  const series = [{ key: "balance", name: checking?.account.name ?? "Checking", color: CHECKING_COLOR }];

  // 30 days counted back from the most recent update (data-derived, so the
  // figure is stable for a given history).
  const monthAgo = checking?.latest ? checking.latest.recordedAt.getTime() - 30 * 86_400_000 : 0;
  const monthAgoBalance = [...history].reverse().find((u) => u.recordedAt.getTime() <= monthAgo)?.balance;
  const change30 =
    checking?.latest && monthAgoBalance != null ? checking.latest.balance - monthAgoBalance : null;

  const newestFirst = [...history].reverse();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-ink">
            {checking?.account.name ?? "Checking account"}
            {checking && <RenameCheckingButton currentName={checking.account.name} />}
          </h1>
          <p className="text-sm text-ink-2">
            {checking?.latest
              ? `Last updated ${formatDistanceToNow(checking.latest.recordedAt, { addSuffix: true })}`
              : "No balance recorded yet"}
          </p>
        </div>
        <UpdateCheckingButton currentBalance={checking?.latest?.balance} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: "Current balance",
            value: checking?.latest ? formatCents(checking.latest.balance) : "—",
            tone: checking?.latest && checking.latest.balance < 0 ? "bad" : undefined,
          },
          {
            label: "Change, 30 days",
            value: change30 != null ? formatCents(change30, { signed: true }) : "—",
            tone: change30 != null ? (change30 >= 0 ? "good" : "bad") : undefined,
          },
          {
            label: "Other spending per day",
            value: forecast.usesHistory ? formatCents(forecast.otherSpendingPerDay, { signed: true }) : "—",
            sub: forecast.usesHistory
              ? `Not explained by income, bills or card payments, over ${forecast.driftWindowDays} days`
              : forecast.driftWindowDays > 0
                ? `Needs ${MIN_WINDOW_DAYS} days of history; have ${forecast.driftWindowDays}`
                : "Record checking balances over time to measure it",
            tone: forecast.usesHistory ? (forecast.otherSpendingPerDay >= 0 ? "good" : "bad") : undefined,
          },
          {
            label: "Projected month end",
            value: forecast.endOfMonthBalance != null ? formatCents(forecast.endOfMonthBalance) : "—",
            sub: "After scheduled income, bills and card payments",
            tone: forecast.endOfMonthBalance != null && forecast.endOfMonthBalance < 0 ? "bad" : undefined,
          },
        ].map((tile) => (
          <div key={tile.label} className="rounded-xl border border-hairline bg-surface px-5 py-4">
            <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">{tile.label}</p>
            <p
              className={cx(
                "money mt-1.5 text-xl font-semibold",
                tile.tone === "bad" ? "text-critical" : tile.tone === "good" ? "text-good-text" : "text-ink"
              )}
            >
              {tile.value}
            </p>
            {"sub" in tile && tile.sub && <p className="mt-1 text-xs text-ink-2">{tile.sub}</p>}
          </div>
        ))}
      </div>

      <Panel
        title="Recurring income"
        aside={
          monthlyIncome > 0
            ? `${formatCents(monthlyIncome)} a month on average`
            : "Scheduled deposits feed the forecast"
        }
      >
        <div className="space-y-3">
          {incomes.length === 0 ? (
            <EmptyState title="No recurring income yet">
              Add a salary and the forecast switches from a straight line to the
              real pattern — balance falling between paydays, jumping when you
              are paid.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-hairline">
              {incomes.map((income) => {
                const next = income.active ? nextOccurrenceDate(income, now) : null;
                return (
                  <li key={income.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0">
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className={cx("text-sm font-medium", income.active ? "text-ink" : "text-muted line-through")}>
                          {income.name}
                        </span>
                        {!income.active && (
                          <span className="rounded-full bg-page px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted">
                            Paused
                          </span>
                        )}
                      </span>
                      <span className="block text-xs text-ink-2">
                        {SCHEDULE_FREQUENCY_LABELS[income.frequency as ScheduleFrequency]}
                        {" · "}
                        {formatCents(monthlyEquivalent(income))} a month
                        {next && <> · next on {format(next, "MMM d")}</>}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <Money cents={income.amount} className={cx("text-sm font-medium", income.active ? "text-good-text" : "text-muted")} />
                      <IncomeRowActions income={income} dates={scheduleDateInputs(income)} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex justify-end">
            <AddIncomeButton />
          </div>
        </div>
      </Panel>

      <Panel
        title="Scheduled expenses"
        aside={
          monthlyExpense > 0
            ? `${formatCents(monthlyExpense)} a month on average`
            : "Rent, leases, utilities — anything you know is coming"
        }
      >
        <div className="space-y-3">
          {expenses.length === 0 ? (
            <EmptyState title="No scheduled expenses yet">
              Add the bills you already know about. A bill that varies can be
              entered as an estimate and corrected once the real one arrives.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-hairline">
              {expenses.map((expense) => {
                const next = expense.active ? nextOccurrenceDate(expense, now) : null;
                return (
                  <li key={expense.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0">
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className={cx("text-sm font-medium", expense.active ? "text-ink" : "text-muted line-through")}>
                          {expense.name}
                        </span>
                        {expense.estimated && (
                          <span className="rounded-full bg-warning-wash px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-2">
                            Estimate
                          </span>
                        )}
                        {!expense.active && (
                          <span className="rounded-full bg-page px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted">
                            Paused
                          </span>
                        )}
                      </span>
                      <span className="block text-xs text-ink-2">
                        {SCHEDULE_FREQUENCY_LABELS[expense.frequency as ScheduleFrequency]}
                        {" · "}
                        {formatCents(monthlyEquivalent(expense))} a month
                        {next && <> · next on {format(next, "MMM d")}</>}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <Money cents={expense.amount} className={cx("text-sm font-medium", expense.active ? "text-ink" : "text-muted")} />
                      <ExpenseRowActions expense={expense} dates={scheduleDateInputs(expense)} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex justify-end">
            <AddExpenseButton />
          </div>
        </div>
      </Panel>

      {forecast.expenses.length > 0 && (
        <Panel title="Upcoming bills" aside="Next 45 days">
          <ul className="divide-y divide-hairline">
            {forecast.expenses.map((bill) => (
              <li
                key={`${bill.expenseId}-${bill.dateISO}`}
                className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className={cx("text-sm font-medium", bill.skipped ? "text-muted line-through" : "text-ink")}>
                      {bill.name}
                    </span>
                    {bill.skipped ? (
                      <span className="rounded-full bg-page px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted">
                        Skipped
                      </span>
                    ) : bill.adjusted ? (
                      <span className="rounded-full bg-good-wash px-1.5 py-0.5 text-[10px] font-semibold uppercase text-good-text">
                        Actual
                      </span>
                    ) : bill.estimated ? (
                      <span className="rounded-full bg-warning-wash px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-2">
                        Estimate
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-xs text-ink-2">
                    Due {format(new Date(`${bill.dateISO}T00:00:00`), "EEEE, MMM d")}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <Money cents={bill.amount} className={cx("text-sm font-medium", bill.skipped ? "text-muted" : "text-ink")} />
                  <AdjustBillButton
                    expenseId={bill.expenseId}
                    expenseName={bill.name}
                    dueDateISO={bill.dateISO}
                    currentAmount={bill.amount}
                    adjusted={bill.adjusted}
                  />
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Balance history" aside="Last 120 days">
        {history.length > 0 ? (
          <TrendChart rows={rows} series={series} />
        ) : (
          <EmptyState title="No history yet">
            Record the balance whenever it changes — salary arriving, rent going out, a refund landing.
          </EmptyState>
        )}
      </Panel>

      <Panel title="Updates" aside={`${history.length} recorded`}>
        {newestFirst.length === 0 ? (
          <EmptyState title="Nothing recorded yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
                  <th className="pb-2 pr-3 font-semibold">Date</th>
                  <th className="pb-2 pr-3 text-right font-semibold">Balance</th>
                  <th className="pb-2 pr-3 text-right font-semibold">Change</th>
                  <th className="pb-2 font-semibold">Reason</th>
                </tr>
              </thead>
              <tbody>
                {newestFirst.slice(0, 50).map((u, i) => {
                  const prev = newestFirst[i + 1];
                  const delta = prev ? u.balance - prev.balance : null;
                  return (
                    <tr key={u.id} className="border-b border-hairline/60 last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap text-ink-2">{format(u.recordedAt, "MMM d, yyyy")}</td>
                      <td className="py-2 pr-3 text-right">
                        <Money cents={u.balance} className={cx(u.balance < 0 ? "text-critical" : "text-ink")} />
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {delta == null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <Money
                            cents={delta}
                            signed
                            className={cx("text-xs", delta >= 0 ? "text-good-text" : "text-critical")}
                          />
                        )}
                      </td>
                      <td className="py-2 text-ink-2">{u.reason ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
