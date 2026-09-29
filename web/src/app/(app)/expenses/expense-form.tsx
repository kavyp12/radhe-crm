"use client";

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
import { MODE_ACCOUNT, RECEIPT_MODE, RECEIPT_MODES, type ReceiptMode } from "@/lib/receipt-modes";

export type ExpenseFormValues = {
  date: string;
  categoryId: string;
  vendorId: string;
  jobId: string;
  amount: string;
  mode: ReceiptMode;
  moneyAccountId: string;
  notes: string;
};

export type ExpenseFormOptions = {
  categories: { id: number; name: string }[];
  vendors: { id: number; name: string }[];
  jobs: { id: number; number: string; customer: string }[];
  accounts: { id: number; name: string; systemKey: string | null }[];
};

export function ExpenseForm({
  values: v,
  options,
  askReason,
  submitLabel,
  back,
  action,
}: {
  values: ExpenseFormValues;
  options: ExpenseFormOptions;
  askReason?: boolean;
  submitLabel: string;
  back: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
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
  const [mode, setMode] = useState<ReceiptMode>(v.mode);
  const [accountId, setAccountId] = useState(v.moneyAccountId);
  function changeMode(next: ReceiptMode) {
    setMode(next);
    const account = options.accounts.find((a) => a.systemKey === MODE_ACCOUNT[next]);
    if (account) setAccountId(String(account.id));
  }

  return (
    <form onSubmit={onSubmit} className="grid max-w-4xl grid-cols-1 gap-4">
      <FormSection title="Expense" description="Numbered when saved (EX/…) and posted to the books. Attach the bill photo after saving.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Date" error={error("date")}>
            <DateInput name="date" defaultValue={v.date} required />
          </Field>
          <Field label="Category" error={error("categoryId")}>
            <NativeSelect name="categoryId" defaultValue={v.categoryId} className="w-full" required>
              <NativeSelectOption value="">Pick the category…</NativeSelectOption>
              {options.categories.map((c) => (
                <NativeSelectOption key={c.id} value={String(c.id)}>
                  {c.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Amount (₹)" error={error("amount")}>
            <Input name="amount" defaultValue={v.amount} inputMode="decimal" required className="text-right tabular-nums" />
          </Field>
          <Field label="Mode" error={error("mode")}>
            <NativeSelect name="mode" value={mode} onChange={(e) => changeMode(e.target.value as ReceiptMode)} className="w-full">
              {RECEIPT_MODES.map((m) => (
                <NativeSelectOption key={m} value={m}>
                  {RECEIPT_MODE[m]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Paid from" hint="Set by the mode; change it if needed." error={error("moneyAccountId")}>
            <NativeSelect name="moneyAccountId" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-full">
              {options.accounts.map((a) => (
                <NativeSelectOption key={a.id} value={String(a.id)}>
                  {a.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Vendor" hint="Optional." error={error("vendorId")}>
            <NativeSelect name="vendorId" defaultValue={v.vendorId} className="w-full">
              <NativeSelectOption value="">—</NativeSelectOption>
              {options.vendors.map((x) => (
                <NativeSelectOption key={x.id} value={String(x.id)}>
                  {x.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Job" hint="Optional: the job's cost." error={error("jobId")} className="sm:col-span-2 lg:col-span-1">
            <NativeSelect name="jobId" defaultValue={v.jobId} className="w-full">
              <NativeSelectOption value="">—</NativeSelectOption>
              {options.jobs.map((j) => (
                <NativeSelectOption key={j.id} value={String(j.id)}>
                  {j.number} · {j.customer}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Notes" error={error("notes")} className="sm:col-span-2">
            <Textarea name="notes" rows={2} defaultValue={v.notes} maxLength={2000} />
          </Field>
        </div>
      </FormSection>

      {askReason && (
        <FormSection title="Reason" description="An old expense goes to the owner for approval; say why.">
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
