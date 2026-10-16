"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/cards", label: "Cards" },
  { href: "/checking", label: "Checking" },
] as const;

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1" aria-label="Main">
      {LINKS.map((l) => {
        const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              active ? "bg-accent-wash text-accent-strong" : "text-ink-2 hover:bg-page hover:text-ink"
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
