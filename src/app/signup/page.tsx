import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/auth";
import { SignUpForm } from "@/components/accountForms";
import { AuthShell } from "@/components/AuthShell";

export const metadata = { title: "Create an account — Ledgerline" };

export default async function SignUpPage() {
  if (await getSessionUserId()) redirect("/");
  return (
    <AuthShell subtitle="Create an account to track your cards and checking balance.">
      <SignUpForm />
    </AuthShell>
  );
}
