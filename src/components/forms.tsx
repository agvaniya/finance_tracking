"use client";

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import type { CreditCard, RecurringExpense, RecurringIncome } from "@prisma/client";
import { format } from "date-fns";
import {
  adjustBill,
  clearBillAdjustment,
  createCard,
  createExpense,
  createIncome,
  deleteExpense,
  deleteIncome,
  recordCardBalance,
  recordPayment,
  renameChecking,
  setExpenseActive,
  setIncomeActive,
  updateCard,
  updateChecking,
  updateExpense,
  updateIncome,
  type ActionState,
} from "@/lib/actions";
import {
  AUTO_PAY_LABELS,
  AUTO_PAY_TYPES,
  SCHEDULE_FREQUENCIES,
  SCHEDULE_FREQUENCY_LABELS,
  usesDayOfMonth,
  type AutoPayType,
  type ScheduleFrequency,
} from "@/lib/domain";
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

// ---------- recurring schedules (shared by income and expenses) ----------

interface ScheduleShape {
  name: string;
  amount: number;
  frequency: string;
  dayOfMonth: number | null;
  secondDayOfMonth: number | null;
}

/**
 * yyyy-mm-dd values for the date inputs, formatted on the server (see
 * scheduleDateInputs) so they match how the actions parse them.
 */
export interface ScheduleDates {
  anchorDateISO: string | null;
  startDateISO: string | null;
}

function ScheduleFields({
  schedule,
  dates,
  nameLabel,
  namePlaceholder,
  amountLabel,
  amountHint,
  defaultFrequency,
}: {
  schedule?: ScheduleShape;
  dates?: ScheduleDates;
  nameLabel: string;
  namePlaceholder: string;
  amountLabel: string;
  amountHint: string;
  defaultFrequency: ScheduleFrequency;
}) {
  const [frequency, setFrequency] = useState<ScheduleFrequency>(
    (schedule?.frequency as ScheduleFrequency) ?? defaultFrequency
  );
  // A new schedule defaults to the browser's own today, not the UTC date.
  const anchorDefault = dates?.anchorDateISO ?? format(new Date(), "yyyy-MM-dd");
  const dayLabel = frequency === "SEMI_MONTHLY" ? "First day of month" : "Day of month";

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label={nameLabel} hint="Shown on the calendar and forecast.">
          <input name="name" required defaultValue={schedule?.name} placeholder={namePlaceholder} className={inputClass} />
        </Field>
        <Field label={amountLabel} hint={amountHint}>
          <MoneyInput name="amount" required defaultCents={schedule?.amount} />
        </Field>
      </div>

      <Field label="How often">
        <select
          name="frequency"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value as ScheduleFrequency)}
          className={inputClass}
        >
          {SCHEDULE_FREQUENCIES.map((f) => (
            <option key={f} value={f}>
              {SCHEDULE_FREQUENCY_LABELS[f]}
            </option>
          ))}
        </select>
      </Field>

      {usesDayOfMonth(frequency) ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label={dayLabel} hint="Days past a month's end shift to the last day.">
            <input
              type="number"
              name="dayOfMonth"
              min={1}
              max={31}
              required
              defaultValue={schedule?.dayOfMonth ?? 1}
              className={cx(inputClass, "money")}
            />
          </Field>
          {frequency === "SEMI_MONTHLY" && (
            <Field label="Second day of month">
              <input
                type="number"
                name="secondDayOfMonth"
                min={1}
                max={31}
                required
                defaultValue={schedule?.secondDayOfMonth ?? 15}
                className={cx(inputClass, "money")}
              />
            </Field>
          )}
        </div>
      ) : (
        <Field label="Most recent date" hint="The cycle repeats from this date.">
          <input type="date" name="anchorDate" required defaultValue={anchorDefault} className={inputClass} />
        </Field>
      )}

      <Field
        label="First payment (optional)"
        hint="Only if it has not started yet. Leave blank for one already running."
      >
        <input type="date" name="startDate" defaultValue={dates?.startDateISO ?? ""} className={inputClass} />
      </Field>
    </>
  );
}

// ---------- recurring income ----------

function IncomeFields({ income, dates }: { income?: RecurringIncome; dates?: ScheduleDates }) {
  return (
    <ScheduleFields
      schedule={income}
      dates={dates}
      nameLabel="Name"
      namePlaceholder="Acme Corp salary"
      amountLabel="Amount per payment"
      amountHint="Take-home, after deductions."
      defaultFrequency="SEMI_MONTHLY"
    />
  );
}

export function AddIncomeButton({ variant = "secondary" }: { variant?: keyof typeof buttonStyles }) {
  const d = useDialog();
  return (
    <>
      <button type="button" onClick={d.show} className={buttonStyles[variant]}>
        Add income
      </button>
      {d.open && (
        <DialogShell key={d.key} title="Add recurring income" onClose={d.hide}>
          <DialogForm action={createIncome} submitLabel="Add income" onDone={d.hide}>
            <IncomeFields />
          </DialogForm>
        </DialogShell>
      )}
    </>
  );
}

export function EditIncomeButton({ income, dates }: { income: RecurringIncome; dates: ScheduleDates }) {
  const d = useDialog();
  return (
    <>
      <button type="button" onClick={d.show} className={buttonStyles.ghost}>
        Edit
      </button>
      {d.open && (
        <DialogShell key={d.key} title={`Edit ${income.name}`} onClose={d.hide}>
          <DialogForm action={updateIncome.bind(null, income.id)} submitLabel="Save changes" onDone={d.hide}>
            <IncomeFields income={income} dates={dates} />
          </DialogForm>
        </DialogShell>
      )}
    </>
  );
}

export function IncomeRowActions({ income, dates }: { income: RecurringIncome; dates: ScheduleDates }) {
  const [pending, startTransition] = useTransition();
  return (
    <span className="flex items-center gap-0.5">
      <EditIncomeButton income={income} dates={dates} />
      <button
        type="button"
        disabled={pending}
        className={buttonStyles.ghost}
        onClick={() => startTransition(() => setIncomeActive(income.id, !income.active))}
      >
        {income.active ? "Pause" : "Resume"}
      </button>
      <button
        type="button"
        disabled={pending}
        className={cx(buttonStyles.ghost, "text-critical hover:bg-critical-wash")}
        onClick={() => {
          if (window.confirm(`Remove ${income.name} from the forecast?`)) {
            startTransition(() => deleteIncome(income.id));
          }
        }}
      >
        Remove
      </button>
    </span>
  );
}

// ---------- recurring expenses ----------

function ExpenseFields({ expense, dates }: { expense?: RecurringExpense; dates?: ScheduleDates }) {
  return (
    <>
      <ScheduleFields
        schedule={expense}
        dates={dates}
        nameLabel="Name"
        namePlaceholder="Rent"
        amountLabel="Amount each time"
        amountHint="What you expect to pay."
        defaultFrequency="MONTHLY"
      />
      <label className="flex items-start gap-2.5 rounded-lg border border-hairline bg-page/60 px-3 py-2.5">
        <input
          type="checkbox"
          name="estimated"
          defaultChecked={expense?.estimated ?? false}
          className="mt-0.5 size-4 accent-[#104281]"
        />
        <span className="text-sm text-ink-2">
          This amount varies — treat it as an estimate I will correct when the
          bill arrives
        </span>
      </label>
    </>
  );
}

export function AddExpenseButton({ variant = "secondary" }: { variant?: keyof typeof buttonStyles }) {
  const d = useDialog();
  return (
    <>
      <button type="button" onClick={d.show} className={buttonStyles[variant]}>
        Add expense
      </button>
      {d.open && (
        <DialogShell key={d.key} title="Add a scheduled expense" onClose={d.hide}>
          <DialogForm action={createExpense} submitLabel="Add expense" onDone={d.hide}>
            <ExpenseFields />
          </DialogForm>
        </DialogShell>
      )}
    </>
  );
}

export function ExpenseRowActions({ expense, dates }: { expense: RecurringExpense; dates: ScheduleDates }) {
  const edit = useDialog();
  const [pending, startTransition] = useTransition();
  return (
    <span className="flex items-center gap-0.5">
      <button type="button" onClick={edit.show} className={buttonStyles.ghost}>
        Edit
      </button>
      {edit.open && (
        <DialogShell key={edit.key} title={`Edit ${expense.name}`} onClose={edit.hide}>
          <DialogForm action={updateExpense.bind(null, expense.id)} submitLabel="Save changes" onDone={edit.hide}>
            <ExpenseFields expense={expense} dates={dates} />
          </DialogForm>
        </DialogShell>
      )}
      <button
        type="button"
        disabled={pending}
        className={buttonStyles.ghost}
        onClick={() => startTransition(() => setExpenseActive(expense.id, !expense.active))}
      >
        {expense.active ? "Pause" : "Resume"}
      </button>
      <button
        type="button"
        disabled={pending}
        className={cx(buttonStyles.ghost, "text-critical hover:bg-critical-wash")}
        onClick={() => {
          if (window.confirm(`Remove ${expense.name} from the forecast?`)) {
            startTransition(() => deleteExpense(expense.id));
          }
        }}
      >
        Remove
      </button>
    </span>
  );
}

/** Replaces one occurrence's amount with the real bill. */
export function AdjustBillButton({
  expenseId,
  expenseName,
  dueDateISO,
  currentAmount,
  adjusted,
}: {
  expenseId: string;
  expenseName: string;
  dueDateISO: string;
  currentAmount: number;
  adjusted: boolean;
}) {
  const d = useDialog();
  const [pending, startTransition] = useTransition();
  const due = new Date(`${dueDateISO}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  return (
    <>
      <button type="button" onClick={d.show} className={buttonStyles.ghost}>
        {adjusted ? "Change" : "Enter actual"}
      </button>
      {adjusted && (
        <button
          type="button"
          disabled={pending}
          className={buttonStyles.ghost}
          onClick={() => startTransition(() => clearBillAdjustment(expenseId, dueDateISO))}
        >
          Reset
        </button>
      )}
      {d.open && (
        <DialogShell key={d.key} title={`${expenseName} due ${due}`} onClose={d.hide}>
          <DialogForm
            action={adjustBill.bind(null, expenseId, dueDateISO)}
            submitLabel="Save amount"
            onDone={d.hide}
          >
            <Field label="Actual amount" hint="Enter 0 if it will not be charged this time.">
              <MoneyInput name="amount" required defaultCents={currentAmount} />
            </Field>
            <Field label="Note">
              <input name="note" placeholder="Optional" className={inputClass} />
            </Field>
            <p className="text-xs text-muted">
              This changes only the {due} bill. Later ones keep the scheduled amount.
            </p>
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
