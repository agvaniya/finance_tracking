import { format, formatDistanceToNow } from "date-fns";
import { AddCardButton, UpdateCheckingButton } from "@/components/forms";
import { DistributionDonut, ProjectionChart, TrendChart } from "@/components/charts";
import { MonthCalendar } from "@/components/Calendar";
import { Dot, EmptyState, Money, Panel, cx } from "@/components/ui";
import { getTrendData } from "@/lib/chartData";
import { CHECKING_COLOR, seriesColor } from "@/lib/colors";
import { getMonthEvents } from "@/lib/events";
import { formatCents } from "@/lib/money";
import { SAFETY_BUFFER, buildForecast, toISODate } from "@/lib/predictions";
import {
  getCardsWithState,
  getCheckingAccount,
  getCheckingHistory,
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

  const [cards, checking, checkingHistory, trend, activity] = await Promise.all([
    getCardsWithState(),
    getCheckingAccount(),
    getCheckingHistory(),
    getTrendData(90),
    getRecentActivity(10),
  ]);

  const forecast = buildForecast(
    checkingHistory.map((u) => ({ balance: u.balance, recordedAt: u.recordedAt })),
    cards
  );

  const now = new Date();
  const [calYear, calMonth] = /^\d{4}-\d{2}$/.test(month ?? "")
    ? [Number(month!.slice(0, 4)), Number(month!.slice(5)) - 1]
    : [now.getFullYear(), now.getMonth()];
  const prev = new Date(calYear, calMonth - 1, 1);
  const next = new Date(calYear, calMonth + 1, 1);
  const events = await getMonthEvents(calYear, calMonth, forecast);

  const totalDebt = cards.reduce((s, c) => s + (c.current?.totalBalance ?? 0), 0);
  const dueThisMonth = cards.reduce((s, c) => s + (c.current?.statementBalance ?? 0), 0);
  const alerts = forecast.autoPays.filter((a) => a.severity !== "ok");
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
                <strong>{a.cardName}</strong> auto pay of{" "}
                <span className="money font-medium">{formatCents(a.amount)}</span> on{" "}
                {format(new Date(`${a.dateISO}T00:00:00`), "MMM d")}{" "}
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          cents={cards.length ? dueThisMonth : null}
          sub={
            forecast.autoPayTotalThisMonth > 0
              ? `${formatCents(forecast.autoPayTotalThisMonth)} on auto pay`
              : "No auto pays remaining"
          }
        />
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
              forecast.driftWindowDays > 0
                ? `Projected from ${forecast.driftWindowDays} days of history (${formatCents(forecast.dailyDrift)}/day net)`
                : "Record checking balances to enable projections"
            }
          >
            {forecast.points.length > 0 ? (
              <div className="grid gap-6 lg:grid-cols-[1fr_230px]">
                <ProjectionChart points={forecast.points} autoPays={forecast.autoPays} buffer={SAFETY_BUFFER} />
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
                  <div>
                    <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Upcoming auto pays</p>
                    {forecast.autoPays.length === 0 ? (
                      <p className="text-sm text-ink-2">None scheduled in the next 45 days.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {forecast.autoPays.map((a) => (
                          <li key={`${a.cardId}-${a.dateISO}`} className="flex items-center justify-between gap-2 text-sm">
                            <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
                              <Dot color={seriesColor(a.colorSlot)} />
                              <span className="truncate">{a.cardName}</span>
                              <span className="shrink-0 text-xs text-muted">
                                {format(new Date(`${a.dateISO}T00:00:00`), "MMM d")}
                              </span>
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
                    return (
                      <li key={item.id} className="flex items-start gap-2.5">
                        <span className="mt-1.5">
                          <Dot color={item.colorSlot == null ? CHECKING_COLOR : seriesColor(item.colorSlot)} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-sm font-medium text-ink">
                              {isPayment ? `Payment — ${item.label}` : item.label}
                            </span>
                            <Money
                              cents={isPayment ? -amount : amount}
                              signed={isPayment}
                              className={cx("shrink-0 text-sm", isPayment && "text-good-text")}
                            />
                          </span>
                          <span className="block text-xs text-ink-2">
                            {item.reason ? `${item.reason} · ` : ""}
                            {formatDistanceToNow(item.when, { addSuffix: true })}
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
