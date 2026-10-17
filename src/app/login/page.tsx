import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/auth";
import { SignInForm } from "@/components/accountForms";
import { AuthShell } from "@/components/AuthShell";

export const metadata = { title: "Sign in — Ledgerline" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ deleted?: string }>;
}) {
  if (await getSessionUserId()) redirect("/");
  const { deleted } = await searchParams;

  return (
    <AuthShell>
      {deleted === "1" && (
        <p className="mb-4 rounded-lg bg-good-wash px-3 py-2 text-sm text-good-text">
          Your account and all of its data have been deleted.
        </p>
      )}
      <SignInForm />
    </AuthShell>
  );
}
