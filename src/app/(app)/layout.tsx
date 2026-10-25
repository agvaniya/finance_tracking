import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { signOut } from "@/lib/accountActions";
import { getSessionUser } from "@/lib/auth";
import { NavLinks } from "@/components/NavLinks";
import { UserMenu } from "@/components/accountForms";
import { Wordmark } from "@/components/Wordmark";
import { APP_VERSION } from "@/lib/version";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-hairline bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <Wordmark />
          </Link>
          <div className="flex items-center gap-2">
            <NavLinks />
            <UserMenu username={user.username} version={APP_VERSION} signOutAction={signOut} />
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
