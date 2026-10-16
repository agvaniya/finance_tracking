"use client";

import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CreditCard } from "@prisma/client";
import {
  createCard,
  login,
  recordCardBalance,
  recordPayment,
  renameChecking,
  updateCard,
  updateChecking,
  type ActionState,
} from "@/lib/actions";
import { AUTO_PAY_LABELS, AUTO_PAY_TYPES, type AutoPayType } from "@/lib/domain";
import { buttonStyles, cx } from "./ui";

// ---------- shared field primitives ----------

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20";

function MoneyInput({
  name,
  defaultCents,
  required,
  placeholder = "0.00",
}: {
  name: string;
  defaultCents?: number | null;
  required?: boolean;
  placeholder?: string;
}) {
  const defaultValue =
    defaultCents != null ? (defaultCents / 100).toFixed(2) : undefined;
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted">$</span>
      <input
        type="text"
        inputMode="decimal"
        name={name}
        defaultValue={defaultValue}
        required={required}
        placeholder={placeholder}
        className={cx(inputClass, "money pl-7")}
      />
    </div>
  );
}

// ---------- dialog shell ----------

function DialogShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 pt-[8vh]"
      onMouseDown={(e) => {
        if (ref.current && !ref.current.contains(e.target as Node)) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
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
    </div>
  );
}

type BoundAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

function DialogForm({
  action,
  submitLabel,
  onDone,
  children,
}: {
  action: BoundAction;
  submitLabel: string;
  onDone: () => void;
  children: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  useEffect(() => {
    if (state.ok) onDone();
  }, [state.ok, onDone]);

  return (
    <form action={formAction} className="space-y-4">
      {children}
      {state.error && (
        <p role="alert" className="rounded-lg bg-critical-wash px-3 py-2 text-sm text-critical">
          {state.error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onDone} className={buttonStyles.secondary}>
          Cancel
        </button>
        <button type="submit" disabled={pending} className={buttonStyles.primary}>
          {pending ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

function useDialog() {
  const [openCount, setOpenCount] = useState(0);
  const [open, setOpen] = useState(false);
  return {
    open,
    key: openCount,
    show: () => {
      setOpenCount((c) => c + 1);
      setOpen(true);
    },
    hide: () => setOpen(false),
  };
}

// ---------- card create / edit ----------

function CardFields({ card }: { card?: CreditCard }) {
  const [autoPayType, setAutoPayType] = useState<AutoPayType>(
    (card?.autoPayType as AutoPayType) ?? "STATEMENT"
  );
  const selectId = useId();
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Card name">
          <input name="name" required defaultValue={card?.name} placeholder="Sapphire Preferred" className={inputClass} />
        </Field>
        <Field label="Issuer">
          <input name="issuer" defaultValue={card?.issuer ?? ""} placeholder="Chase" className={inputClass} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Credit limit">
          <MoneyInput name="creditLimit" required defaultCents={card?.creditLimit} />
        </Field>
        <Field label="Last four digits">
          <input name="lastFour" defaultValue={card?.lastFour ?? ""} placeholder="4821" maxLength={4} className={cx(inputClass, "money")} />
        </Field>
      </div>
      <Field label="Auto pay">
        <select
          id={selectId}
          name="autoPayType"
          value={autoPayType}
          onChange={(e) => setAutoPayType(e.target.value as AutoPayType)}
          className={inputClass}
        >
          {AUTO_PAY_TYPES.map((t) => (
            <option key={t} value={t}>
              {AUTO_PAY_LABELS[t]}
            </option>
          ))}
        </select>
      </Field>
      {autoPayType !== "NONE" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Auto pay day of month" hint="Days past a month's end are clamped.">
            <input
              type="number"
              name="autoPayDay"
              min={1}
              max={31}
              required
              defaultValue={card?.autoPayDay ?? 1}
              className={cx(inputClass, "money")}
            />
          </Field>
          {autoPayType === "FIXED" && (
            <Field label="Fixed amount">
              <MoneyInput name="autoPayFixedAmount" required defaultCents={card?.autoPayFixedAmount} />
            </Field>
          )}
          {autoPayType === "MINIMUM" && (
            <Field label="Minimum payment">
              <MoneyInput name="minimumPayment" defaultCents={card?.minimumPayment ?? 3500} />
            </Field>
          )}
        </div>
      )}
      {!card && (
        <div className="grid grid-cols-2 gap-3 border-t border-hairline pt-4">
          <Field label="Current balance" hint="Optional — you can record it later.">
            <MoneyInput name="initialBalance" />
          </Field>
          <Field label="Due this month" hint="Last month's statement balance.">
            <MoneyInput name="initialStatement" />
          </Field>
        </div>
      )}
    </>
  );
}

export function AddCardButton({ className }: { className?: string }) {
  const d = useDialog();
  return (
    <>
      <button type="button" onClick={d.show} className={className ?? buttonStyles.primary}>
        Add card
      </button>
      {d.open && (
        <DialogShell key={d.key} title="Add a credit card" onClose={d.hide}>
          <DialogForm action={createCard} submitLabel="Add card" onDone={d.hide}>
            <CardFields />
          </DialogForm>
        </DialogShell>
      )}
    </>
  );
}

export function EditCardButton({ card }: { card: CreditCard }) {
  const d = useDialog();
  return (
    <>
      <button type="button" onClick={d.show} className={buttonStyles.secondary}>
        Edit card
      </button>
      {d.open && (
        <DialogShell key={d.key} title={`Edit ${card.name}`} onClose={d.hide}>
          <DialogForm action={updateCard.bind(null, card.id)} submitLabel="Save changes" onDone={d.hide}>
            <CardFields card={card} />
          </DialogForm>
        </DialogShell>
      )}
    </>
  );
}

// ---------- balance update ----------

export function UpdateBalanceButton({
  cardId,
  cardName,
  currentTotal,
  currentStatement,
  variant = "secondary",
}: {
  cardId: string;
  cardName: string;
  currentTotal?: number;
  currentStatement?: number;
  variant?: keyof typeof buttonStyles;
}) {
  const d = useDialog();
  return (
    <>
      <button type="button" onClick={d.show} className={buttonStyles[variant]}>
        Update balance
      </button>
      {d.open && (
        <DialogShell key={d.key} title={`Update ${cardName} balance`} onClose={d.hide}>
          <DialogForm action={recordCardBalance.bind(null, cardId)} submitLabel="Record balance" onDone={d.hide}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Total balance">
                <MoneyInput name="totalBalance" required defaultCents={currentTotal} />
              </Field>
              <Field label="Due this month" hint="Last month's statement balance.">
                <MoneyInput name="statementBalance" required defaultCents={currentStatement} />
              </Field>
            </div>
            <Field label="Reason for change" hint="e.g. Statement posted, vacation spending, refund issued.">
              <input name="reason" placeholder="Optional" className={inputClass} />
            </Field>
          </DialogForm>
        </DialogShell>
      )}
    </>
  );
}

// ---------- payment ----------

export function RecordPaymentButton({
  cardId,
  cardName,
  variant = "secondary",
}: {
  cardId: string;
  cardName: string;
  variant?: keyof typeof buttonStyles;
}) {
  const d = useDialog();
  return (
    <>
      <button type="button" onClick={d.show} className={buttonStyles[variant]}>
        Record payment
      </button>
      {d.open && (
        <DialogShell key={d.key} title={`Record a payment to ${cardName}`} onClose={d.hide}>
          <DialogForm action={recordPayment.bind(null, cardId)} submitLabel="Record payment" onDone={d.hide}>
            <Field label="Amount paid">
              <MoneyInput name="amount" required />
            </Field>
            <Field label="Note">
              <input name="note" placeholder="e.g. Extra payment from bonus" className={inputClass} />
            </Field>
            <label className="flex items-start gap-2.5 rounded-lg border border-hairline bg-page/60 px-3 py-2.5">
              <input type="checkbox" name="deductFromChecking" className="mt-0.5 size-4 accent-[#104281]" />
              <span className="text-sm text-ink-2">
                Also deduct this amount from the checking balance
              </span>
            </label>
          </DialogForm>
        </DialogShell>
      )}
    </>
  );
}

// ---------- checking update ----------

export function UpdateCheckingButton({
  currentBalance,
  variant = "primary",
}: {
  currentBalance?: number;
  variant?: keyof typeof buttonStyles;
}) {
  const d = useDialog();
  return (
    <>
      <button type="button" onClick={d.show} className={buttonStyles[variant]}>
        Update checking
      </button>
      {d.open && (
        <DialogShell key={d.key} title="Update checking balance" onClose={d.hide}>
          <DialogForm action={updateChecking} submitLabel="Record balance" onDone={d.hide}>
            <Field label="Current balance">
              <MoneyInput name="balance" required defaultCents={currentBalance} />
            </Field>
            <Field label="Reason for change" hint="e.g. Salary deposited, gift received, refund issued.">
              <input name="reason" placeholder="Optional" className={inputClass} />
            </Field>
          </DialogForm>
        </DialogShell>
      )}
    </>
  );
}

export function RenameCheckingButton({ currentName }: { currentName: string }) {
  const d = useDialog();
  return (
    <>
      <button type="button" onClick={d.show} className={buttonStyles.ghost}>
        Rename
      </button>
      {d.open && (
        <DialogShell key={d.key} title="Rename checking account" onClose={d.hide}>
          <DialogForm action={renameChecking} submitLabel="Save name" onDone={d.hide}>
            <Field label="Account name">
              <input name="name" required defaultValue={currentName} className={inputClass} />
            </Field>
          </DialogForm>
        </DialogShell>
      )}
    </>
  );
}

// ---------- login ----------

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, {});
  return (
    <form action={formAction} className="space-y-4">
      <Field label="Password">
        <input
          type="password"
          name="password"
          required
          autoFocus
          autoComplete="current-password"
          className={inputClass}
        />
      </Field>
      {state.error && (
        <p role="alert" className="rounded-lg bg-critical-wash px-3 py-2 text-sm text-critical">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className={cx(buttonStyles.primary, "w-full")}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
