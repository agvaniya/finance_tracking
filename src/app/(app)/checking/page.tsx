import { format, formatDistanceToNow } from "date-fns";
import { TrendChart } from "@/components/charts";
import { RenameCheckingButton, UpdateCheckingButton } from "@/components/forms";
import { EmptyState, Money, Panel, cx } from "@/components/ui";
import { sampleDailySeries } from "@/lib/chartData";
import { CHECKING_COLOR } from "@/lib/colors";
import { formatCents } from "@/lib/money";
import { buildForecast } from "@/lib/predictions";
import { getCardsWithState, getCheckingAccount, getCheckingHistory } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function CheckingPage() {
  const [checking, history, cards] = await Promise.all([
    getCheckingAccount(),
    getCheckingHistory(),
    getCardsWithState(),
  ]);

  const forecast = buildForecast(
    history.map((u) => ({ balance: u.balance, recordedAt: u.recordedAt })),
    cards
  );

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
            label: "Net per day",
            value: forecast.driftWindowDays > 0 ? formatCents(forecast.dailyDrift, { signed: true }) : "—",
            sub: forecast.driftWindowDays > 0 ? `From ${forecast.driftWindowDays} days of history` : undefined,
            tone: forecast.driftWindowDays > 0 ? (forecast.dailyDrift >= 0 ? "good" : "bad") : undefined,
          },
          {
            label: "Projected month end",
            value: forecast.endOfMonthBalance != null ? formatCents(forecast.endOfMonthBalance) : "—",
            sub: "After scheduled auto pays",
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
