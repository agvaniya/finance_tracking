import type { ReactNode } from "react";
import { APP_VERSION } from "@/lib/version";
import { Wordmark } from "./Wordmark";

/** Shared frame for the signed-out pages: sign in, sign up, password reset. */
export function AuthShell({ children, subtitle }: { children: ReactNode; subtitle?: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Wordmark large />
          <p className="text-sm text-ink-2">
            {subtitle ?? "Credit card balances, checking account, and the month ahead."}
          </p>
        </div>
        <div className="rounded-xl border border-hairline bg-surface p-6 shadow-[0_1px_2px_rgba(11,11,11,0.04)]">
          {children}
        </div>
      </div>
      <p className="fixed bottom-3 right-4 text-[11px] text-muted" aria-label="App version">
        v{APP_VERSION}
      </p>
    </main>
  );
}
