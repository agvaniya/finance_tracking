import Link from "next/link";
import type { ReactNode } from "react";
import { logout } from "@/lib/actions";
import { requireSession } from "@/lib/auth";
import { NavLinks } from "@/components/NavLinks";
import { Wordmark } from "@/components/Wordmark";

export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireSession();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-hairline bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <Wordmark />
          </Link>
          <div className="flex items-center gap-2">
            <NavLinks />
            <form action={logout}>
              <button
                type="submit"
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-page hover:text-ink"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">{children}</main>
      <footer className="mx-auto w-full max-w-6xl px-4 pb-6 text-xs text-muted sm:px-6">
        Amounts are what you&apos;ve recorded. Update balances regularly to keep predictions honest.
      </footer>
    </div>
  );
}
