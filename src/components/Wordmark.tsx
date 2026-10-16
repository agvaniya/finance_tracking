export function Wordmark({ large }: { large?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg
        width={large ? 28 : 20}
        height={large ? 28 : 20}
        viewBox="0 0 20 20"
        aria-hidden
        className="shrink-0"
      >
        <rect x="2" y="4" width="16" height="2.4" rx="1.2" fill="var(--accent)" />
        <rect x="2" y="9" width="11" height="2.4" rx="1.2" fill="var(--accent)" opacity="0.65" />
        <rect x="2" y="14" width="6" height="2.4" rx="1.2" fill="var(--accent)" opacity="0.35" />
      </svg>
      <span
        className={`font-semibold tracking-tight text-ink ${large ? "text-2xl" : "text-base"}`}
      >
        Ledgerline
      </span>
    </span>
  );
}
