import { redirect } from "next/navigation";
import { hasValidSession } from "@/lib/auth";
import { LoginForm } from "@/components/forms";
import { Wordmark } from "@/components/Wordmark";

export const metadata = { title: "Sign in — Ledgerline" };

export default async function LoginPage() {
  if (await hasValidSession()) redirect("/");
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Wordmark large />
          <p className="text-sm text-ink-2">
            Credit card balances, checking account, and the month ahead.
          </p>
        </div>
        <div className="rounded-xl border border-hairline bg-surface p-6 shadow-[0_1px_2px_rgba(11,11,11,0.04)]">
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
