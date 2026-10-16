// All amounts are integer cents.

export function formatCents(cents: number, opts?: { signed?: boolean }): string {
  const sign = cents < 0 ? "-" : opts?.signed && cents > 0 ? "+" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}$${dollars.toLocaleString("en-US")}.${rem.toString().padStart(2, "0")}`;
}

/** Compact form for chart axes: $1.2k, $35k */
export function formatCentsCompact(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents) / 100;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1000)}k`;
  if (abs >= 1_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

/** Parse a user-entered dollar amount ("1,234.56", "$1200") into cents. */
export function parseDollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (cleaned === "" || !/^-?\d*(\.\d{0,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}
