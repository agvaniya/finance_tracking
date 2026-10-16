// Validated categorical palette (fixed slot order — never cycled, never
// reassigned when cards come and go; each card stores its slot).
export const SERIES = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
] as const;

export function seriesColor(slot: number): string {
  return SERIES[((slot % SERIES.length) + SERIES.length) % SERIES.length];
}

/** Checking account line — the app accent, distinct from all card slots. */
export const CHECKING_COLOR = "#104281";

export const STATUS = {
  good: "#0ca30c",
  goodText: "#006300",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

export const CHART_CHROME = {
  grid: "#e1e0d9",
  baseline: "#c3c2b7",
  muted: "#898781",
  ink2: "#52514e",
} as const;
