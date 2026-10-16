import { seriesColor, CHECKING_COLOR } from "./colors";
import { toISODate } from "./predictions";
import { getCardHistories, getCheckingHistory, getCardsWithState } from "./queries";

export interface TrendSeries {
  key: string;
  name: string;
  color: string;
}

export type TrendRow = { dateISO: string } & Record<string, string | number | null>;

const DAY = 86_400_000;

/**
 * Pure daily step-sampler for one or more named point series:
 * each day carries the last known value forward.
 */
export function sampleDailySeries(
  pointsByKey: Record<string, { t: number; v: number }[]>,
  days: number
): TrendRow[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = today.getTime() - days * DAY;
  const cursors = Object.entries(pointsByKey).map(([key, points]) => ({
    key,
    points,
    idx: 0,
    value: null as number | null,
  }));
  const rows: TrendRow[] = [];
  for (let t = start; t <= today.getTime(); t += DAY) {
    const endOfDay = t + DAY - 1;
    const row: TrendRow = { dateISO: toISODate(new Date(t)) };
    for (const c of cursors) {
      while (c.idx < c.points.length && c.points[c.idx].t <= endOfDay) {
        c.value = c.points[c.idx].v;
        c.idx++;
      }
      row[c.key] = c.value;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Daily step-sampled history for the trend chart: each day carries the last
 * recorded value forward, so the lines reflect "what we knew" between updates.
 */
export async function getTrendData(days = 90): Promise<{ rows: TrendRow[]; series: TrendSeries[] }> {
  const [cards, cardHistories, checkingHistory] = await Promise.all([
    getCardsWithState(),
    getCardHistories(),
    getCheckingHistory(),
  ]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = today.getTime() - days * DAY;

  const series: TrendSeries[] = [
    { key: "checking", name: "Checking", color: CHECKING_COLOR },
    ...cards.map(({ card }) => ({
      key: `card_${card.id}`,
      name: card.name,
      color: seriesColor(card.colorSlot),
    })),
  ];

  // Walk each history with a cursor per series.
  const cursors = new Map<string, { idx: number; value: number | null; points: { t: number; v: number }[] }>();
  cursors.set("checking", {
    idx: 0,
    value: null,
    points: checkingHistory.map((u) => ({ t: u.recordedAt.getTime(), v: u.balance })),
  });
  for (const { card } of cards) {
    const history = cardHistories.get(card.id) ?? [];
    cursors.set(`card_${card.id}`, {
      idx: 0,
      value: null,
      points: history.map((u) => ({ t: u.recordedAt.getTime(), v: u.totalBalance })),
    });
  }

  const rows: TrendRow[] = [];
  for (let t = start; t <= today.getTime(); t += DAY) {
    const endOfDay = t + DAY - 1;
    const row: TrendRow = { dateISO: toISODate(new Date(t)) };
    for (const [key, cursor] of cursors) {
      while (cursor.idx < cursor.points.length && cursor.points[cursor.idx].t <= endOfDay) {
        cursor.value = cursor.points[cursor.idx].v;
        cursor.idx++;
      }
      row[key] = cursor.value;
    }
    rows.push(row);
  }

  return { rows, series };
}
