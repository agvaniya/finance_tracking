"use client";

import { format, parseISO } from "date-fns";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_CHROME, CHECKING_COLOR, STATUS } from "@/lib/colors";
import { formatCents, formatCentsCompact } from "@/lib/money";
import type {
  ForecastCardPayment,
  ForecastExpense,
  ForecastIncome,
  ForecastPoint,
} from "@/lib/predictions";
import type { TrendRow, TrendSeries } from "@/lib/chartData";

const axisTick = { fill: CHART_CHROME.muted, fontSize: 11 } as const;

// Loose structural view of recharts' tooltip content props (their generic
// types changed across v3 minors; we only read these fields).
interface TooltipContentView {
  active?: boolean;
  label?: unknown;
  payload?: Array<{
    value?: unknown;
    name?: unknown;
    color?: string;
    stroke?: string;
    payload?: unknown;
  }>;
}

function dateTick(iso: string): string {
  return format(parseISO(iso), "MMM d");
}

interface TooltipRow {
  color: string;
  name: string;
  value: number;
}

function ChartTooltip({ title, rows, footer }: { title: string; rows: TooltipRow[]; footer?: string }) {
  return (
    <div className="rounded-lg border border-hairline bg-surface px-3 py-2 shadow-md">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</p>
      <div className="space-y-0.5">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center justify-between gap-4 text-xs">
            <span className="flex items-center gap-1.5 text-ink-2">
              <span className="size-2 rounded-full" style={{ backgroundColor: r.color }} />
              {r.name}
            </span>
            <span className="money font-medium text-ink">{formatCents(r.value)}</span>
          </div>
        ))}
      </div>
      {footer && <p className="mt-1.5 max-w-52 border-t border-hairline pt-1.5 text-[11px] text-ink-2">{footer}</p>}
    </div>
  );
}

function Legend({ series }: { series: { name: string; color: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {series.map((s) => (
        <span key={s.name} className="flex items-center gap-1.5 text-xs text-ink-2">
          <span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

// ---------- balance trends ----------

export function TrendChart({ rows, series }: { rows: TrendRow[]; series: TrendSeries[] }) {
  return (
    <div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
            <CartesianGrid vertical={false} stroke={CHART_CHROME.grid} />
            <XAxis
              dataKey="dateISO"
              tick={axisTick}
              tickFormatter={dateTick}
              axisLine={{ stroke: CHART_CHROME.baseline }}
              tickLine={false}
              minTickGap={48}
            />
            <YAxis
              tick={axisTick}
              tickFormatter={formatCentsCompact}
              axisLine={false}
              tickLine={false}
              width={52}
            />
            <Tooltip
              cursor={{ stroke: CHART_CHROME.baseline, strokeDasharray: "3 3" }}
              content={(props: unknown) => {
                const { active, payload, label } = props as TooltipContentView;
                if (!active || !payload?.length) return null;
                return (
                  <ChartTooltip
                    title={dateTick(String(label))}
                    rows={payload
                      .filter((p) => p.value != null)
                      .map((p) => ({
                        color: String(p.stroke ?? p.color ?? "var(--ink)"),
                        name: String(p.name),
                        value: Number(p.value),
                      }))}
                  />
                );
              }}
            />
            {series.map((s) => (
              <Line
                key={s.key}
                type="stepAfter"
                dataKey={s.key}
                name={s.name}
                stroke={s.color}
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <Legend series={series} />
    </div>
  );
}

// ---------- balance distribution donut ----------

export interface DonutSlice {
  name: string;
  value: number;
  color: string;
}

export function DistributionDonut({ slices, centerLabel }: { slices: DonutSlice[]; centerLabel: string }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  return (
    <div className="flex items-center gap-5">
      <div className="relative h-44 w-44 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius={56}
              outerRadius={82}
              paddingAngle={2}
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((s) => (
                <Cell key={s.name} fill={s.color} />
              ))}
            </Pie>
            <Tooltip
              content={(props: unknown) => {
                const { active, payload } = props as TooltipContentView;
                if (!active || !payload?.length) return null;
                const p = payload[0];
                const value = Number(p.value);
                return (
                  <ChartTooltip
                    title={String(p.name)}
                    rows={[{ color: (p.payload as DonutSlice).color, name: "Balance", value }]}
                    footer={total > 0 ? `${Math.round((value / total) * 100)}% of total debt` : undefined}
                  />
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="money text-base font-semibold text-ink">{formatCentsCompact(total)}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted">{centerLabel}</span>
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {slices.map((s) => (
          <div key={s.name} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2 text-ink-2">
              <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
              <span className="truncate">{s.name}</span>
            </span>
            <span className="money shrink-0 font-medium text-ink">{formatCents(s.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- checking runway projection ----------

export function ProjectionChart({
  points,
  cardPayments,
  incomes = [],
  expenses = [],
  buffer,
}: {
  points: ForecastPoint[];
  cardPayments: ForecastCardPayment[];
  incomes?: ForecastIncome[];
  expenses?: ForecastExpense[];
  buffer: number;
}) {
  const expenseByDate = new Map<string, ForecastExpense[]>();
  for (const e of expenses) {
    if (e.skipped) continue;
    expenseByDate.set(e.dateISO, [...(expenseByDate.get(e.dateISO) ?? []), e]);
  }
  const byDate = new Map(cardPayments.map((a) => [a.dateISO, a] as const));
  const incomeByDate = new Map<string, ForecastIncome[]>();
  for (const i of incomes) {
    incomeByDate.set(i.dateISO, [...(incomeByDate.get(i.dateISO) ?? []), i]);
  }
  const min = Math.min(0, ...points.map((p) => p.balance));
  const eventColor = (s: ForecastCardPayment["severity"]) =>
    s === "overdraft" ? STATUS.critical : s === "tight" ? STATUS.warning : CHECKING_COLOR;

  return (
    <div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id="runway" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHECKING_COLOR} stopOpacity={0.18} />
                <stop offset="100%" stopColor={CHECKING_COLOR} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke={CHART_CHROME.grid} />
            <XAxis
              dataKey="dateISO"
              tick={axisTick}
              tickFormatter={dateTick}
              axisLine={{ stroke: CHART_CHROME.baseline }}
              tickLine={false}
              minTickGap={48}
            />
            <YAxis
              tick={axisTick}
              tickFormatter={formatCentsCompact}
              axisLine={false}
              tickLine={false}
              width={52}
              domain={[Math.min(min * 1.1, -10_000), "auto"]}
            />
            <Tooltip
              cursor={{ stroke: CHART_CHROME.baseline, strokeDasharray: "3 3" }}
              content={(props: unknown) => {
                const { active, payload, label } = props as TooltipContentView;
                if (!active || !payload?.length) return null;
                const event = byDate.get(String(label));
                const paydays = incomeByDate.get(String(label)) ?? [];
                const bills = expenseByDate.get(String(label)) ?? [];
                const notes = [
                  ...paydays.map((p) => `${p.name} ${formatCents(p.amount, { signed: true })}`),
                  ...bills.map(
                    (b) =>
                      `${b.name} −${formatCents(b.amount)}${b.estimated && !b.adjusted ? " (est)" : ""}`
                  ),
                  ...(event
                    ? [
                        `${event.cardName} ${event.kind === "autopay" ? "auto pay" : "payment"} ${formatCents(event.amount)}${
                          event.estimated ? " (est)" : ""
                        }${
                          event.severity === "overdraft"
                            ? " — overdraws the account"
                            : event.severity === "tight"
                              ? " — dips below the buffer"
                              : ""
                        }`,
                      ]
                    : []),
                ];
                return (
                  <ChartTooltip
                    title={dateTick(String(label))}
                    rows={[{ color: CHECKING_COLOR, name: "Projected checking", value: Number(payload[0].value) }]}
                    footer={notes.length > 0 ? notes.join(" · ") : undefined}
                  />
                );
              }}
            />
            <ReferenceLine y={buffer} stroke={CHART_CHROME.baseline} strokeDasharray="4 4" />
            <ReferenceLine y={0} stroke={STATUS.critical} strokeWidth={1} />
            <Area
              type="monotone"
              dataKey="balance"
              name="Projected checking"
              stroke={CHECKING_COLOR}
              strokeWidth={2}
              fill="url(#runway)"
              dot={false}
              isAnimationActive={false}
            />
            {[...incomeByDate.keys()].map((dateISO) => {
              const point = points.find((p) => p.dateISO === dateISO);
              if (!point) return null;
              return (
                <ReferenceDot
                  key={`income-${dateISO}`}
                  x={dateISO}
                  y={point.balance}
                  r={5}
                  fill={STATUS.goodText}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              );
            })}
            {cardPayments.map((a) => {
              const point = points.find((p) => p.dateISO === a.dateISO);
              if (!point) return null;
              return (
                <ReferenceDot
                  key={`${a.cardId}-${a.dateISO}`}
                  x={a.dateISO}
                  y={point.balance}
                  r={5}
                  fill={eventColor(a.severity)}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              );
            })}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        {incomes.length > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ backgroundColor: STATUS.goodText }} /> Payday
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-accent" /> Auto pay scheduled
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ backgroundColor: STATUS.warning }} /> Dips below buffer
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ backgroundColor: STATUS.critical }} /> Would overdraw
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0 w-5 border-t border-dashed border-baseline" /> Safety buffer
        </span>
      </div>
    </div>
  );
}
