import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ArchiveCardButton } from "@/components/CardActions";
import { TrendChart } from "@/components/charts";
import { EditCardButton, RecordPaymentButton, UpdateBalanceButton } from "@/components/forms";
import { EmptyState, Money, Panel, cx } from "@/components/ui";
import { sampleDailySeries } from "@/lib/chartData";
import { seriesColor } from "@/lib/colors";
import { AUTO_PAY_LABELS, type AutoPayType } from "@/lib/domain";
import { formatCents } from "@/lib/money";
import { getCard } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function CardDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const card = await getCard(id);
  if (!card) notFound();

  const current = card.balanceUpdates[0] ?? null;
  const color = seriesColor(card.colorSlot);
  const chronological = [...card.balanceUpdates].reverse();

  const rows = sampleDailySeries(
    {
      total: chronological.map((u) => ({ t: u.recordedAt.getTime(), v: u.totalBalance })),
      statement: chronological.map((u) => ({ t: u.recordedAt.getTime(), v: u.statementBalance })),
    },
    120
  );
  const series = [
    { key: "total", name: "Total balance", color },
    { key: "statement", name: "Due this month", color: "#898781" },
  ];

  const utilization =
    current && card.creditLimit > 0 ? Math.round((current.totalBalance / card.creditLimit) * 100) : 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/cards" className="text-xs font-medium text-accent-strong hover:underline">
            ← All cards
          </Link>
          <h1 className="mt-1 flex items-center gap-2.5 text-xl font-semibold tracking-tight text-ink">
            <span className="inline-block size-3 rounded-full" style={{ backgroundColor: color }} />
            {card.name}
            {card.archivedAt && (
              <span className="rounded-full bg-page px-2 py-0.5 text-xs font-medium text-muted">Archived</span>
            )}
          </h1>
          <p className="text-sm text-ink-2">
            {[card.issuer, card.lastFour ? `•••• ${card.lastFour}` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <UpdateBalanceButton
            cardId={card.id}
            cardName={card.name}
            currentTotal={current?.totalBalance}
            currentStatement={current?.statementBalance}
            variant="primary"
          />
          <RecordPaymentButton cardId={card.id} cardName={card.name} />
          <EditCardButton card={card} />
          {!card.archivedAt && <ArchiveCardButton cardId={card.id} cardName={card.name} />}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Total balance", value: current ? formatCents(current.totalBalance) : "—" },
          { label: "Due this month", value: current ? formatCents(current.statementBalance) : "—" },
          { label: "Credit limit", value: formatCents(card.creditLimit), sub: `${utilization}% used` },
          {
            label: "Auto pay",
            value:
              card.autoPayType === "NONE" || card.autoPayDay == null
                ? "Off"
                : `Day ${card.autoPayDay}`,
            sub:
              card.autoPayType === "NONE"
                ? undefined
                : card.autoPayType === "FIXED" && card.autoPayFixedAmount != null
                  ? `${AUTO_PAY_LABELS[card.autoPayType as AutoPayType]} · ${formatCents(card.autoPayFixedAmount)}`
                  : AUTO_PAY_LABELS[card.autoPayType as AutoPayType],
            mono: false,
          },
        ].map((tile) => (
          <div key={tile.label} className="rounded-xl border border-hairline bg-surface px-5 py-4">
            <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">{tile.label}</p>
            <p className={cx("mt-1.5 text-xl font-semibold text-ink", tile.mono !== false && "money")}>{tile.value}</p>
            {tile.sub && <p className="mt-1 text-xs text-ink-2">{tile.sub}</p>}
          </div>
        ))}
      </div>

      <Panel title="Balance history" aside="Last 120 days">
        {chronological.length > 0 ? (
          <TrendChart rows={rows} series={series} />
        ) : (
          <EmptyState title="No balance recorded yet" />
        )}
      </Panel>

      <div className="grid gap-5 lg:grid-cols-5">
        <Panel title="Balance updates" className="lg:col-span-3">
          {card.balanceUpdates.length === 0 ? (
            <EmptyState title="No updates yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hairline text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
                    <th className="pb-2 pr-3 font-semibold">Date</th>
                    <th className="pb-2 pr-3 text-right font-semibold">Total</th>
                    <th className="pb-2 pr-3 text-right font-semibold">Due</th>
                    <th className="pb-2 font-semibold">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {card.balanceUpdates.slice(0, 40).map((u) => (
                    <tr key={u.id} className="border-b border-hairline/60 last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap text-ink-2">{format(u.recordedAt, "MMM d, yyyy")}</td>
                      <td className="py-2 pr-3 text-right">
                        <Money cents={u.totalBalance} className="text-ink" />
                      </td>
                      <td className="py-2 pr-3 text-right">
                        <Money cents={u.statementBalance} className="text-ink-2" />
                      </td>
                      <td className="py-2 text-ink-2">
                        {u.kind === "PAYMENT" && (
                          <span className="mr-1.5 rounded-full bg-good-wash px-1.5 py-0.5 text-[10px] font-semibold uppercase text-good-text">
                            payment
                          </span>
                        )}
                        {u.reason ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Payments" className="lg:col-span-2">
          {card.payments.length === 0 ? (
            <EmptyState title="No payments recorded" />
          ) : (
            <ul className="space-y-2.5">
              {card.payments.slice(0, 25).map((p) => (
                <li key={p.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0">
                    <span className="block text-ink">{p.note ?? "Payment"}</span>
                    <span className="block text-xs text-muted">{format(p.paidAt, "MMM d, yyyy")}</span>
                  </span>
                  <Money cents={-p.amount} signed className="shrink-0 font-medium text-good-text" />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
