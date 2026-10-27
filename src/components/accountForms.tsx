"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, type ReactNode, useTransition } from "react";
import { createPortal } from "react-dom";
import {
  changePassword,
  deleteAccount,
  lookupSecurityQuestions,
  resetPassword,
  signIn,
  signUp, setTheme } from "@/lib/accountActions";
import { THEMES, THEME_LABELS, type Theme } from "@/lib/theme";
import { SECURITY_QUESTIONS } from "@/lib/securityQuestions";
import { buttonStyles, cx } from "./ui";

const inputClass =
  "w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

function ErrorNote({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-critical-wash px-3 py-2 text-sm text-critical">
      {message}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

export function SignInForm() {
  const [state, formAction, pending] = useActionState(signIn, {});
  return (
    <form action={formAction} className="space-y-4">
      <Field label="Username">
        <input name="username" required autoFocus autoComplete="username" className={inputClass} />
      </Field>
      <Field label="Password">
        <input type="password" name="password" required autoComplete="current-password" className={inputClass} />
      </Field>
      <ErrorNote message={state.error} />
      <button type="submit" disabled={pending} className={cx(buttonStyles.primary, "w-full")}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <div className="flex items-center justify-between pt-1 text-sm">
        <Link href="/forgot-password" className="text-accent-strong hover:underline">
          Forgot password?
        </Link>
        <Link href="/signup" className="text-accent-strong hover:underline">
          Create an account
        </Link>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Sign up
// ---------------------------------------------------------------------------

function QuestionPicker({ index, exclude }: { index: number; exclude: string }) {
  const options = SECURITY_QUESTIONS.filter((q) => q !== exclude);
  return (
    <>
      <Field label={`Security question ${index + 1}`}>
        <select name={`question${index}`} defaultValue={options[index] ?? options[0]} className={inputClass}>
          {SECURITY_QUESTIONS.map((q) => (
            <option key={q} value={q}>
              {q}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Answer" hint="Capitalisation and extra spaces are ignored.">
        <input name={`answer${index}`} required autoComplete="off" className={inputClass} />
      </Field>
    </>
  );
}

export function SignUpForm() {
  const [state, formAction, pending] = useActionState(signUp, {});
  return (
    <form action={formAction} className="space-y-4">
      <Field label="Username" hint="Letters, numbers, dots, dashes and underscores.">
        <input name="username" required autoFocus autoComplete="username" className={inputClass} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Password" hint="At least 10 characters.">
          <input type="password" name="password" required autoComplete="new-password" className={inputClass} />
        </Field>
        <Field label="Confirm password">
          <input type="password" name="confirmPassword" required autoComplete="new-password" className={inputClass} />
        </Field>
      </div>

      <div className="rounded-lg border border-hairline bg-page/60 p-3">
        <p className="mb-3 text-xs text-ink-2">
          These two answers are the only way back in if you forget your
          password, so pick things you will not misremember.
        </p>
        <div className="space-y-3">
          <QuestionPicker index={0} exclude="" />
          <QuestionPicker index={1} exclude={SECURITY_QUESTIONS[0]} />
        </div>
      </div>

      <ErrorNote message={state.error} />
      <button type="submit" disabled={pending} className={cx(buttonStyles.primary, "w-full")}>
        {pending ? "Creating account…" : "Create account"}
      </button>
      <p className="pt-1 text-center text-sm text-ink-2">
        Already have an account?{" "}
        <Link href="/login" className="text-accent-strong hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Forgotten password
// ---------------------------------------------------------------------------

export function ForgotPasswordForm() {
  const [lookup, lookupAction, lookingUp] = useActionState(lookupSecurityQuestions, {});
  const [reset, resetAction, resetting] = useActionState(resetPassword, {});

  if (!lookup.questions) {
    return (
      <form action={lookupAction} className="space-y-4">
        <Field label="Username" hint="We will ask your security questions next.">
          <input name="username" required autoFocus autoComplete="username" className={inputClass} />
        </Field>
        <ErrorNote message={lookup.error} />
        <button type="submit" disabled={lookingUp} className={cx(buttonStyles.primary, "w-full")}>
          {lookingUp ? "Looking up…" : "Continue"}
        </button>
        <p className="pt-1 text-center text-sm">
          <Link href="/login" className="text-accent-strong hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    );
  }

  return (
    <form action={resetAction} className="space-y-4">
      <input type="hidden" name="username" value={lookup.username} />
      <p className="text-sm text-ink-2">
        Answer both questions for <strong className="text-ink">{lookup.username}</strong>.
      </p>
      {lookup.questions.map((question, i) => (
        <Field key={question} label={question}>
          <input name={`answer${i}`} required autoFocus={i === 0} autoComplete="off" className={inputClass} />
        </Field>
      ))}
      <div className="grid grid-cols-2 gap-3 border-t border-hairline pt-4">
        <Field label="New password" hint="At least 10 characters.">
          <input type="password" name="password" required autoComplete="new-password" className={inputClass} />
        </Field>
        <Field label="Confirm password">
          <input type="password" name="confirmPassword" required autoComplete="new-password" className={inputClass} />
        </Field>
      </div>
      <ErrorNote message={reset.error} />
      <button type="submit" disabled={resetting} className={cx(buttonStyles.primary, "w-full")}>
        {resetting ? "Resetting…" : "Reset password and sign in"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// User menu
// ---------------------------------------------------------------------------

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  // This dialog is opened from the header, which carries backdrop-blur. A
  // backdrop-filter makes that element the containing block for fixed-position
  // descendants, so an inline dialog would be positioned — and clipped —
  // inside the 56px header instead of the viewport. Rendering into document.body
  // sidesteps that entirely.
  //
  // The dialog only ever renders after a click, so document exists by then;
  // the guard is purely for safety during server rendering.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 pt-[10vh]"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (ref.current && !ref.current.contains(e.target as Node)) onClose();
      }}
    >
      <div ref={ref} className="w-full max-w-md rounded-xl border border-hairline bg-surface shadow-xl">
        <header className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted hover:bg-page hover:text-ink">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body
  );
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [state, formAction, pending] = useActionState(changePassword, {});
  useEffect(() => {
    if (state.ok) onClose();
  }, [state.ok, onClose]);

  return (
    <Dialog title="Change password" onClose={onClose}>
      <form action={formAction} className="space-y-4">
        <Field label="Current password">
          <input type="password" name="currentPassword" required autoFocus autoComplete="current-password" className={inputClass} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="New password" hint="At least 10 characters.">
            <input type="password" name="password" required autoComplete="new-password" className={inputClass} />
          </Field>
          <Field label="Confirm">
            <input type="password" name="confirmPassword" required autoComplete="new-password" className={inputClass} />
          </Field>
        </div>
        <ErrorNote message={state.error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonStyles.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={pending} className={buttonStyles.primary}>
            {pending ? "Saving…" : "Change password"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteAccountDialog({ username, onClose }: { username: string; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(deleteAccount, {});
  return (
    <Dialog title="Delete account" onClose={onClose}>
      <form action={formAction} className="space-y-4">
        <div className="rounded-lg border border-critical/40 bg-critical-wash px-3 py-2.5 text-sm text-ink">
          This permanently deletes your cards, balances, payment history,
          checking account and every schedule. It cannot be undone.
        </div>
        <Field label="Password">
          <input type="password" name="password" required autoFocus autoComplete="current-password" className={inputClass} />
        </Field>
        <Field label={`Type ${username} to confirm`}>
          <input name="confirmUsername" required autoComplete="off" className={inputClass} />
        </Field>
        <ErrorNote message={state.error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonStyles.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={pending} className={buttonStyles.danger}>
            {pending ? "Deleting…" : "Delete my account"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AppearancePicker({ current }: { current: string }) {
  const [theme, setThemeState] = useState(current);
  const [, startTransition] = useTransition();
  const choose = (next: Theme) => {
    setThemeState(next);
    // Apply at once; the server remembers it and re-renders to match.
    const root = document.documentElement;
    if (next === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);
    startTransition(() => setTheme(next));
  };
  return (
    <div className="border-b border-hairline px-3 py-2">
      <span className="block text-[11px] uppercase tracking-wide text-muted">Appearance</span>
      <div role="radiogroup" aria-label="Appearance" className="mt-1.5 grid grid-cols-3 gap-1 rounded-lg bg-page p-0.5">
        {THEMES.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={theme === t}
            onClick={() => choose(t)}
            className={cx(
              "rounded-md px-2 py-1 text-xs font-medium transition-colors",
              theme === t ? "bg-surface text-ink shadow-[0_1px_2px_rgba(11,11,11,0.08)]" : "text-ink-2 hover:text-ink"
            )}
          >
            {THEME_LABELS[t]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function UserMenu({
  username,
  theme,
  version,
  signOutAction,
}: {
  username: string;
  theme: string;
  version: string;
  signOutAction: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"password" | "delete" | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item =
    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-2 transition-colors hover:bg-page hover:text-ink";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium text-ink-2 transition-colors hover:bg-page hover:text-ink"
      >
        <span className="hidden max-w-32 truncate sm:inline">{username}</span>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
          <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 w-56 overflow-hidden rounded-xl border border-hairline bg-surface py-1 shadow-lg"
        >
          <p className="border-b border-hairline px-3 pb-2 pt-1.5">
            <span className="block text-[11px] uppercase tracking-wide text-muted">Signed in as</span>
            <span className="block truncate text-sm font-medium text-ink">{username}</span>
          </p>
          <AppearancePicker current={theme} />
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); setDialog("password"); }}>
            Change password
          </button>
          <button
            type="button"
            role="menuitem"
            className={cx(item, "text-critical hover:bg-critical-wash hover:text-critical")}
            onClick={() => { setOpen(false); setDialog("delete"); }}
          >
            Delete account
          </button>
          <form action={signOutAction} className="border-t border-hairline">
            <button type="submit" role="menuitem" className={item}>
              Sign out
            </button>
          </form>
          <p className="border-t border-hairline px-3 py-1.5 text-[11px] text-muted">Ledgerline v{version}</p>
        </div>
      )}

      {dialog === "password" && <ChangePasswordDialog onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteAccountDialog username={username} onClose={() => setDialog(null)} />}
    </div>
  );
}
