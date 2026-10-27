import { format, formatDistanceToNow } from "date-fns";
import {
  AddCardButton,
  AddOneTimeIncomeButton,
  LastExpenseActions,
  RecordExpenseButton,
  UpdateCheckingButton,
} from "@/components/forms";
import { DistributionDonut, ProjectionChart, TrendChart } from "@/components/charts";
import { MonthCalendar } from "@/components/Calendar";
import { Dot, EmptyState, Money, Panel, cx } from "@/components/ui";
import { requireUserId } from "@/lib/auth";
import { getTrendData } from "@/lib/chartData";
import { CHECKING_COLOR, STATUS, seriesColor } from "@/lib/colors";
import { getMonthEvents } from "@/lib/events";
import { formatCents } from "@/lib/money";
import { HISTORY_DAYS, SAFETY_BUFFER, buildForecast, toISODate } from "@/lib/predictions";
import {
  getCardHistories,
  getCardPayments,
  getCardsWithState,
  getCheckingAccount,
  getCheckingHistory,
  getExpenseAdjustments,
  getExpenses,
  getIncomes,
  getLastExpenses,
  getOneTimeIncomes,
  getRecentActivity,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

function StatTile({
  label,
  cents,
  sub,
  tone,
}: {
  label: string;
  cents: number | null;
  sub?: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface px-5 py-4 shadow-[0_1px_2px_rgba(11,11,11,0.04)]">
      <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</p>
      <p
        className={cx(
          "money mt-1.5 text-2xl font-semibold",
          tone === "bad" ? "text-critical" : tone === "good" ? "text-good-text" : "text-ink"
        )}
      >
        {cents == null ? "—" : formatCents(cents)}
      </p>
      {sub && <p className="mt-1 text-xs text-ink-2">{sub}</p>}
    </div>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { month } = await searchParams;
  const userId = await requireUserId();

  const [
    cards,
    checking,
    checkingHistory,
    trend,
    activity,
    incomes,
    expenses,
    adjustments,
    cardHistories,
    cardPayments,
    oneTimeIncomes,
    lastExpenses,
  ] = await Promise.all([
    getCardsWithState(userId),
    getCheckingAccount(userId),
    getCheckingHistory(userId),
    getTrendData(userId, 90),
    getRecentActivity(userId, 10),
    getIncomes(userId),
    getExpenses(userId),
    getExpenseAdjustments(userId),
    getCardHistories(userId, HISTORY_DAYS),
    getCardPayments(userId, HISTORY_DAYS),
    getOneTimeIncomes(userId, HISTORY_DAYS),
    getLastExpenses(userId),
  ]);
  const editableExpenses = new Map(lastExpenses.filter((e) => e.editable).map((e) => [`ex-${e.id}`, e]));
  const expenseTargets = cards.map((c) => ({ id: c.card.id, name: c.card.name }));

  const forecast = buildForecast({
    checkingHistory,
    cards,
    incomes,
    expenses,
    adjustments,
    cardPayments,
    cardUpdates: [...cardHistories.values()].flat(),
    oneTimeIncomes,
  });

  const now = new Date();
  // Bills corrected to $0 are only listed on the checking page, where they can be reset.
  const upcomingBills = forecast.expenses.filter((b) => !b.skipped);
  const [calYear, calMonth] = /^\d{4}-\d{2}$/.test(month ?? "")
    ? [Number(month!.slice(0, 4)), Number(month!.slice(5)) - 1]
    : [now.getFullYear(), now.getMonth()];
  const prev = new Date(calYear, calMonth - 1, 1);
  const next = new Date(calYear, calMonth + 1, 1);
  const events = await getMonthEvents(userId, calYear, calMonth, forecast);

  const totalDebt = cards.reduce((s, c) => s + (c.current?.totalBalance ?? 0), 0);
  const alerts = forecast.cardPayments.filter((a) => a.severity !== "ok");
  const endOfMonthLabel = format(new Date(now.getFullYear(), now.getMonth() + 1, 0), "MMM d");

  const donutSlices = cards
    .filter((c) => (c.current?.totalBalance ?? 0) > 0)
    .map((c) => ({
      name: c.card.name,
      value: c.current!.totalBalance,
      color: seriesColor(c.card.colorSlot),
    }));

  const hasAnyData = cards.length > 0 || checking;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Dashboard</h1>
          <p className="text-sm text-ink-2">{format(now, "EEEE, MMMM d, yyyy")}</p>
        </div>
        <div className="flex gap-2">
          <RecordExpenseButton cards={expenseTargets} />
          <AddOneTimeIncomeButton />
          <UpdateCheckingButton currentBalance={checking?.latest?.balance} variant="secondary" />
          <AddCardButton />
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((a) => (
            <div
              key={`${a.cardId}-${a.dateISO}`}
              role="alert"
              className={cx(
                "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border px-4 py-3 text-sm",
                a.severity === "overdraft"
                  ? "border-critical/40 bg-critical-wash text-ink"
                  : "border-warning/50 bg-warning-wash text-ink"
              )}
            >
              <span aria-hidden className="text-base leading-none">
                {a.severity === "overdraft" ? "⚠" : "◆"}
              </span>
              <span>
                <strong>{a.cardName}</strong> {a.kind === "autopay" ? "auto pay" : "payment"} of{" "}
                <span className="money font-medium">{formatCents(a.amount)}</span>
                {a.estimated ? " (estimated)" : ""} on {format(new Date(`${a.dateISO}T00:00:00`), "MMM d")}{" "}
                {a.severity === "overdraft" ? (
                  <>
                    would <strong className="text-critical">overdraw checking</strong> to{" "}
                    <span className="money font-medium text-critical">{formatCents(a.balanceAfter)}</span>.
                    Add funds or lower the payment before then.
                  </>
                ) : (
                  <>
                    leaves checking at{" "}
                    <span className="money font-medium">{formatCents(a.balanceAfter)}</span>, below your{" "}
                    <span className="money">{formatCents(SAFETY_BUFFER)}</span> buffer.
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      <div
        className={cx(
          "grid gap-3 sm:grid-cols-2",
          forecast.incomeTotalThisMonth > 0 ? "lg:grid-cols-5" : "lg:grid-cols-4"
        )}
      >
        <StatTile
          label="Checking balance"
          cents={checking?.latest?.balance ?? null}
          sub={
            checking?.latest
              ? `Updated ${formatDistanceToNow(checking.latest.recordedAt, { addSuffix: true })}`
              : "Not recorded yet"
          }
        />
        <StatTile
          label="Total card debt"
          cents={cards.length ? totalDebt : null}
          sub={`Across ${cards.length} card${cards.length === 1 ? "" : "s"}`}
        />
        <StatTile
          label="Due this month"
          cents={cards.length ? forecast.dueThisMonth : null}
          sub={
            forecast.cardPaymentTotalThisMonth > 0
              ? `${formatCents(forecast.cardPaymentTotalThisMonth)} still to be paid`
              : "No card payments remaining"
          }
        />
        {forecast.incomeTotalThisMonth > 0 && (
          <StatTile
            label="Income still to come"
            cents={forecast.incomeTotalThisMonth}
            tone="good"
            sub={`Scheduled before ${endOfMonthLabel}`}
          />
        )}
        <StatTile
          label="Payoff headroom"
          cents={forecast.payoffCapacity}
          tone={forecast.payoffCapacity != null && forecast.payoffCapacity > 0 ? "good" : undefined}
          sub={`Extra you could pay by ${endOfMonthLabel}, keeping a ${formatCents(SAFETY_BUFFER)} buffer`}
        />
      </div>

      {!hasAnyData ? (
        <Panel>
          <EmptyState title="Start by adding a card and your checking balance">
            Record balances as you go — trends, predictions, and the calendar fill in from your history.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <Panel
            title="The month ahead"
            aside={
              forecast.currentChecking == null
                ? "Record a checking balance to enable projections"
                : forecast.usesHistory
                  ? `Scheduled income, bills and card payments, plus ${formatCents(forecast.otherSpendingPerDay, { signed: true })}/day unexplained by them`
                  : "Scheduled income, bills and card payments"
            }
          >
            {forecast.points.length > 0 ? (
              <div className="grid gap-6 lg:grid-cols-[1fr_230px]">
                <ProjectionChart
                  points={forecast.points}
                  cardPayments={forecast.cardPayments}
                  incomes={forecast.incomes}
                  expenses={forecast.expenses}
                  buffer={SAFETY_BUFFER}
                />
                <div className="space-y-4 lg:border-l lg:border-hairline lg:pl-6">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">Expected on {endOfMonthLabel}</p>
                    <p className={cx("money mt-0.5 text-xl font-semibold", (forecast.endOfMonthBalance ?? 0) < 0 ? "text-critical" : "text-ink")}>
                      {forecast.endOfMonthBalance != null ? formatCents(forecast.endOfMonthBalance) : "—"}
                    </p>
                  </div>
                  {forecast.lowestPoint && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Lowest projected point</p>
                      <p className={cx("money mt-0.5 text-sm font-medium", forecast.lowestPoint.balance < 0 ? "text-critical" : "text-ink")}>
                        {formatCents(forecast.lowestPoint.balance)}
                        <span className="ml-1.5 font-sans text-xs font-normal text-ink-2">
                          on {format(new Date(`${forecast.lowestPoint.dateISO}T00:00:00`), "MMM d")}
                        </span>
                      </p>
                    </div>
                  )}
                  {forecast.incomes.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Upcoming income</p>
                      <ul className="space-y-1.5">
                        {forecast.incomes.slice(0, 4).map((income) => (
                          <li key={`${income.incomeId}-${income.dateISO}`} className="flex items-center justify-between gap-2 text-sm">
                            <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
                              <Dot color={STATUS.goodText} />
                              <span className="truncate">{income.name}</span>
                              <span className="shrink-0 text-xs text-muted">
                                {format(new Date(`${income.dateISO}T00:00:00`), "MMM d")}
                              </span>
                            </span>
                            <Money cents={income.amount} signed className="shrink-0 text-good-text" />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {upcomingBills.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Upcoming bills</p>
                      <ul className="space-y-1.5">
                        {upcomingBills.slice(0, 4).map((bill) => (
                          <li key={`${bill.expenseId}-${bill.dateISO}`} className="flex items-center justify-between gap-2 text-sm">
                            <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
                              <span aria-hidden className="shrink-0 text-ink-2">
                                <svg width="8" height="8" viewBox="0 0 8 8">
                                  <path d="M4 7.5 L0.5 1 L7.5 1 Z" fill="currentColor" />
                                </svg>
                              </span>
                              <span className="truncate">{bill.name}</span>
                              <span className="shrink-0 text-xs text-muted">
                                {format(new Date(`${bill.dateISO}T00:00:00`), "MMM d")}
                              </span>
                              {bill.estimated && !bill.adjusted && (
                                <span className="shrink-0 text-[10px] uppercase text-muted">est</span>
                              )}
                            </span>
                            <Money cents={bill.amount} className="shrink-0 text-ink" />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div>
                    <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Upcoming card payments</p>
                    {forecast.cardPayments.length === 0 ? (
                      <p className="text-sm text-ink-2">None expected in the next 45 days.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {forecast.cardPayments.map((a) => (
                          <li key={`${a.cardId}-${a.dateISO}`} className="flex items-center justify-between gap-2 text-sm">
                            <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
                              <Dot color={seriesColor(a.colorSlot)} />
                              <span className="truncate">{a.cardName}</span>
                              <span className="shrink-0 text-xs text-muted">
                                {format(new Date(`${a.dateISO}T00:00:00`), "MMM d")}
                              </span>
                              {a.estimated && <span className="shrink-0 text-[10px] uppercase text-muted">est</span>}
                              {a.kind === "manual" && (
                                <span className="shrink-0 text-[10px] uppercase text-muted">by hand</span>
                              )}
                            </span>
                            <Money cents={a.amount} className={cx("shrink-0 text-ink", a.severity === "overdraft" && "text-critical")} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState title="No checking history yet">
                Update the checking balance a few times and the projection will appear here.
              </EmptyState>
            )}
          </Panel>

          <div className="grid gap-5 lg:grid-cols-5">
            <Panel title="Balance trends" aside="Last 90 days" className="lg:col-span-3">
              {trend.rows.length > 0 ? (
                <TrendChart rows={trend.rows} series={trend.series} />
              ) : (
                <EmptyState title="No history yet" />
              )}
            </Panel>
            <Panel title="Debt by card" aside="Current balances" className="lg:col-span-2">
              {donutSlices.length > 0 ? (
                <DistributionDonut slices={donutSlices} centerLabel="total debt" />
              ) : (
                <EmptyState title="No card balances recorded" />
              )}
            </Panel>
          </div>

          <div className="grid gap-5 lg:grid-cols-5">
            <Panel title="Calendar" className="lg:col-span-3">
              <MonthCalendar
                year={calYear}
                monthIndex={calMonth}
                events={events}
                todayISO={toISODate(now)}
                prevHref={`/?month=${format(prev, "yyyy-MM")}`}
                nextHref={`/?month=${format(next, "yyyy-MM")}`}
              />
            </Panel>
            <Panel title="Recent activity" className="lg:col-span-2">
              {activity.length === 0 ? (
                <EmptyState title="Nothing recorded yet" />
              ) : (
                <ul className="space-y-3">
                  {activity.map((item) => {
                    const amount = Number(item.detail.split(":")[1]);
                    const isPayment = item.kind === "card-payment";
                    const isIncome = item.kind === "one-time-income";
                    const isCharge = item.kind === "expense";
                    const correctable = isCharge ? editableExpenses.get(item.id) : undefined;
                    return (
                      <li key={item.id} className="flex items-start gap-2.5">
                        <span className="mt-1.5">
                          <Dot color={item.colorSlot == null ? CHECKING_COLOR : seriesColor(item.colorSlot)} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-sm font-medium text-ink">
                              {isPayment
                                ? `Payment — ${item.label}`
                                : isIncome
                                  ? `Received — ${item.label}`
                                  : isCharge
                                    ? `Expense — ${item.label}`
                                    : item.label}
                            </span>
                            <Money
                              cents={isPayment ? -amount : amount}
                              signed={isPayment || isIncome || isCharge}
                              className={cx("shrink-0 text-sm", (isPayment || isIncome) && "text-good-text")}
                            />
                          </span>
                          <span className="flex items-center justify-between gap-2">
                            <span className="block text-xs text-ink-2">
                              {item.reason ? `${item.reason} · ` : ""}
                              {formatDistanceToNow(item.when, { addSuffix: true })}
                            </span>
                            {correctable && <LastExpenseActions expense={correctable} cards={expenseTargets} />}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
