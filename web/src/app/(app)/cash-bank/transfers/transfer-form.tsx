"use client";

import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DateInput } from "@/components/date-input";
import { Field, FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";

export type TransferFormValues = { date: string; fromAccountId: string; toAccountId: string; amount: string; reference: string; notes: string };

export function TransferForm({
  values: v,
  accounts,
  transferId,
  askReason,
  submitLabel,
  back,
  action,
  warn,
}: {
  values: TransferFormValues;
  accounts: { id: number; name: string }[];
  /** Set when editing: its own entry is left out of the warning. */
  transferId?: number;
  askReason?: boolean;
  submitLabel: string;
  back: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
  warn: (date: string, fromAccountId: string, amount: string, exceptId?: number) => Promise<string | null>;
}) {
  const router = useRouter();
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
    else if (state?.ok) {
      toast.success(state.message ?? "Saved.");
      router.push(back);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new result arrives
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);

  // D55: the from-account going below zero that day is a warning, never a block. Checked when a field is left.
  const [warning, setWarning] = useState<string | null>(null);
  function check(form: HTMLFormElement | null) {
    if (!form) return;
    const data = new FormData(form);
    const field = (key: string) => String(data.get(key) ?? "");
    warn(field("date"), field("fromAccountId"), field("amount"), transferId).then(setWarning, () => setWarning(null));
  }

  const options = accounts.map((a) => (
    <NativeSelectOption key={a.id} value={String(a.id)}>
      {a.name}
    </NativeSelectOption>
  ));

  return (
    <form onSubmit={onSubmit} onBlur={(e) => check(e.currentTarget)} className="grid max-w-4xl grid-cols-1 gap-4">
      <FormSection title="Transfer" description="Money moved between your own accounts: a cash deposit, UPI to bank, bank to petty cash. Numbered TR/… and posted when saved.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Date" error={error("date")}>
            <DateInput name="date" defaultValue={v.date} required />
          </Field>
          <Field label="From" error={error("fromAccountId")}>
            <NativeSelect name="fromAccountId" defaultValue={v.fromAccountId} onChange={(e) => check(e.currentTarget.form)} className="w-full" required>
              <NativeSelectOption value="">Pick the account…</NativeSelectOption>
              {options}
            </NativeSelect>
          </Field>
          <Field label="To" error={error("toAccountId")}>
            <NativeSelect name="toAccountId" defaultValue={v.toAccountId} className="w-full" required>
              <NativeSelectOption value="">Pick the account…</NativeSelectOption>
              {options}
            </NativeSelect>
          </Field>
          <Field label="Amount (₹)" error={error("amount")}>
            <Input name="amount" inputMode="decimal" defaultValue={v.amount} required className="text-right tabular-nums" />
          </Field>
          <Field label="Reference" hint="Deposit slip or UTR; optional." error={error("reference")} className="sm:col-span-1 lg:col-span-2">
            <Input name="reference" defaultValue={v.reference} maxLength={100} />
          </Field>
          <Field label="Notes" error={error("notes")} className="sm:col-span-2 lg:col-span-3">
            <Textarea name="notes" rows={2} defaultValue={v.notes} maxLength={2000} />
          </Field>
        </div>
        {warning && (
          <p role="status" className="mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{warning} You can still save it.</span>
          </p>
        )}
      </FormSection>

      {askReason && (
        <FormSection title="Reason" description="An old transfer goes to the owner for approval; say why.">
          <Textarea name="reason" rows={2} maxLength={500} aria-label="Reason" />
        </FormSection>
      )}

      <FormError state={state} />
      <FormActions>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </FormActions>
    </form>
  );
}
