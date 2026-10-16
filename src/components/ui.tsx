import type { ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Panel({
  children,
  className,
  title,
  aside,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className={cx("rounded-xl border border-hairline bg-surface shadow-[0_1px_2px_rgba(11,11,11,0.04)]", className)}>
      {(title || aside) && (
        <header className="flex items-baseline justify-between gap-4 border-b border-hairline px-5 py-3">
          {title && <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-ink-2">{title}</h2>}
          {aside && <div className="text-xs text-muted">{aside}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export const buttonStyles = {
  primary:
    "inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50",
  secondary:
    "inline-flex items-center justify-center gap-1.5 rounded-lg border border-hairline bg-surface px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:border-baseline hover:bg-page focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50",
  danger:
    "inline-flex items-center justify-center gap-1.5 rounded-lg border border-critical/30 bg-surface px-3.5 py-2 text-sm font-medium text-critical transition-colors hover:bg-critical-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-critical disabled:opacity-50",
  ghost:
    "inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-ink-2 transition-colors hover:bg-page hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
} as const;

export function Money({
  cents,
  className,
  signed,
}: {
  cents: number;
  className?: string;
  signed?: boolean;
}) {
  const sign = cents < 0 ? "-" : signed && cents > 0 ? "+" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rem = (abs % 100).toString().padStart(2, "0");
  return (
    <span className={cx("money", className)}>
      {sign}${dollars}
      <span className="opacity-60">.{rem}</span>
    </span>
  );
}

export function Dot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: color }}
    />
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-baseline px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-2 text-sm text-ink-2">{children}</div>}
    </div>
  );
}
