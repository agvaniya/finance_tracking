import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import { AddCardButton, RecordPaymentButton, UpdateBalanceButton } from "@/components/forms";
import { Dot, EmptyState, Money, cx } from "@/components/ui";
import { seriesColor } from "@/lib/colors";
import { AUTO_PAY_LABELS, autoPayDateInMonth, type AutoPayType } from "@/lib/domain";
import { requireUserId } from "@/lib/auth";
import { getCardsWithState } from "@/lib/queries";

export const dynamic = "force-dynamic";

function UtilizationBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = pct >= 90 ? "bg-critical" : pct >= 50 ? "bg-serious" : "bg-accent";
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs text-ink-2">
        <span>{pct}% of limit used</span>
        <span className="money">
          <Money cents={limit - used} className="text-ink" /> available
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-page" role="img" aria-label={`${pct}% of credit limit used`}>
        <div className={cx("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default async function CardsPage() {
  const userId = await requireUserId();
  const cards = await getCardsWithState(userId);
  const now = new Date();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Credit cards</h1>
          <p className="text-sm text-ink-2">
            {cards.length} active card{cards.length === 1 ? "" : "s"}
          </p>
        </div>
        <AddCardButton />
      </div>

      {cards.length === 0 ? (
        <EmptyState title="No cards yet">Add your first credit card to start tracking balances.</EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {cards.map(({ card, current }) => {
            let nextAutoPay: Date | null = null;
            if (card.autoPayDay != null && card.autoPayType !== "NONE") {
              nextAutoPay = autoPayDateInMonth(card.autoPayDay, now.getFullYear(), now.getMonth());
              if (nextAutoPay < now) {
                nextAutoPay = autoPayDateInMonth(card.autoPayDay, now.getFullYear(), now.getMonth() + 1);
              }
            }
            return (
              <article
                key={card.id}
                className="rounded-xl border border-hairline bg-surface p-5 shadow-[0_1px_2px_rgba(11,11,11,0.04)]"
                style={{ borderTopColor: seriesColor(card.colorSlot), borderTopWidth: 3 }}
              >
                <header className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/cards/${card.id}`}
                      className="text-base font-semibold text-ink hover:text-accent-strong hover:underline"
                    >
                      {card.name}
                    </Link>
                    <p className="text-xs text-ink-2">
                      {[card.issuer, card.lastFour ? `•••• ${card.lastFour}` : null].filter(Boolean).join(" · ") || "—"}
                    </p>
                  </div>
                  <Dot color={seriesColor(card.colorSlot)} className="mt-1.5 size-2.5" />
                </header>

                <div className="mt-4 flex items-end justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Total balance</p>
                    <p className="money text-2xl font-semibold text-ink">
                      {current ? <Money cents={current.totalBalance} /> : "—"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Due this month</p>
                    <p className="money text-base font-medium text-ink">
                      {current ? <Money cents={current.statementBalance} /> : "—"}
                    </p>
                  </div>
                </div>

                <div className="mt-4">
                  <UtilizationBar used={current?.totalBalance ?? 0} limit={card.creditLimit} />
                </div>

                <p className="mt-3 text-xs text-ink-2">
                  {card.autoPayType === "NONE" || card.autoPayDay == null ? (
                    "No auto pay configured"
                  ) : (
                    <>
                      Auto pay: {AUTO_PAY_LABELS[card.autoPayType as AutoPayType].toLowerCase()}
                      {nextAutoPay && <> · next on {format(nextAutoPay, "MMM d")}</>}
                    </>
                  )}
                  {current && <> · updated {formatDistanceToNow(current.recordedAt, { addSuffix: true })}</>}
                </p>

                <div className="mt-4 flex flex-wrap gap-2">
                  <UpdateBalanceButton
                    cardId={card.id}
                    cardName={card.name}
                    currentTotal={current?.totalBalance}
                    currentStatement={current?.statementBalance}
                  />
                  <RecordPaymentButton cardId={card.id} cardName={card.name} />
                  <Link
                    href={`/cards/${card.id}`}
                    className="inline-flex items-center rounded-lg px-2.5 py-2 text-sm font-medium text-accent-strong hover:bg-accent-wash"
                  >
                    History →
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
