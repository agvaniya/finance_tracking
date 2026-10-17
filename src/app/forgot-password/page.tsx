import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/auth";
import { ForgotPasswordForm } from "@/components/accountForms";
import { AuthShell } from "@/components/AuthShell";

export const metadata = { title: "Reset your password — Ledgerline" };

export default async function ForgotPasswordPage() {
  if (await getSessionUserId()) redirect("/");
  return (
    <AuthShell subtitle="Answer your security questions to set a new password.">
      <ForgotPasswordForm />
    </AuthShell>
  );
}
