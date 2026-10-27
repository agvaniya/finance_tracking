// Every color here is a CSS variable reference, so charts and inline styles
// follow the active theme (light / dark) exactly like the rest of the page.
// The values live in src/app/globals.css.

// Validated categorical palette (fixed slot order — never cycled, never
// reassigned when cards come and go; each card stores its slot).
export const SERIES = [
  "var(--series-0)", // blue
  "var(--series-1)", // orange
  "var(--series-2)", // aqua
  "var(--series-3)", // yellow
  "var(--series-4)", // magenta
  "var(--series-5)", // green
  "var(--series-6)", // violet
  "var(--series-7)", // red
] as const;

export function seriesColor(slot: number): string {
  return SERIES[((slot % SERIES.length) + SERIES.length) % SERIES.length];
}

/** Checking account line — the app accent, distinct from all card slots. */
export const CHECKING_COLOR = "var(--accent)";

export const STATUS = {
  good: "var(--good)",
  /** Darker green used where a mark sits next to text on the surface. */
  goodText: "var(--good-text)",
  warning: "var(--warning)",
  serious: "var(--serious)",
  critical: "var(--critical)",
} as const;

export const CHART_CHROME = {
  grid: "var(--hairline)",
  baseline: "var(--baseline)",
  muted: "var(--muted)",
  ink2: "var(--ink-2)",
} as const;
