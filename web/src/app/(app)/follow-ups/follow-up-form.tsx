"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DateInput } from "@/components/date-input";
import { Field, FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import { formatDate } from "@/lib/dates";

export type FollowUpFormOptions = {
  customers: { id: number; name: string; firmName: string | null; outstanding: bigint }[];
  invoices: { id: number; number: string; customerId: number; date: string }[];
  staff: { id: string; name: string }[];
};

/** S8: one follow-up call. The invoice list follows the customer picked; the customer's outstanding is shown. */
export function FollowUpForm({
  values: v,
  options,
  back,
  action,
}: {
  values: { customerId: string; invoiceId: string; followUpDate: string; personId: string };
  options: FollowUpFormOptions;
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
  const [customerId, setCustomerId] = useState(v.customerId);
  const customer = options.customers.find((c) => String(c.id) === customerId);
  const invoices = options.invoices.filter((i) => String(i.customerId) === customerId);

  return (
    <form onSubmit={onSubmit} className="grid max-w-4xl grid-cols-1 gap-4">
      <FormSection title="Follow-up" description="What the customer said, any promise to pay, and when to call next.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Customer" error={error("customerId")} className="sm:col-span-2">
            <NativeSelect name="customerId" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="w-full" required>
              <NativeSelectOption value="">Pick the customer…</NativeSelectOption>
              {options.customers.map((c) => (
                <NativeSelectOption key={c.id} value={c.id}>
                  {c.firmName ? `${c.name} · ${c.firmName}` : c.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid content-end pb-2 text-sm">
            {customer && (
              <span>
                Outstanding <Money paise={customer.outstanding} drcr className="font-medium" />
              </span>
            )}
          </div>
          <Field label="Invoice (optional)" error={error("invoiceId")}>
            <NativeSelect key={customerId} name="invoiceId" defaultValue={v.invoiceId} className="w-full">
              <NativeSelectOption value="">Whole account</NativeSelectOption>
              {invoices.map((i) => (
                <NativeSelectOption key={i.id} value={i.id}>
                  {i.number} · {formatDate(i.date)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Follow-up date" error={error("followUpDate")}>
            <DateInput name="followUpDate" defaultValue={v.followUpDate} required />
          </Field>
          <Field label="Followed up by" error={error("personId")}>
            <NativeSelect name="personId" defaultValue={v.personId} className="w-full" required>
              {options.staff.map((s) => (
                <NativeSelectOption key={s.id} value={s.id}>
                  {s.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Customer response" error={error("response")} className="sm:col-span-2 lg:col-span-3">
            <Textarea name="response" rows={2} maxLength={1000} />
          </Field>
          <Field label="Promised to pay on" error={error("promiseDate")} hint="With the amount, or leave both blank.">
            <DateInput name="promiseDate" />
          </Field>
          <Field label="Expected amount (₹)" error={error("expected")}>
            <Input name="expected" inputMode="decimal" className="text-right tabular-nums" />
          </Field>
          <Field label="Next reminder" error={error("nextReminderDate")}>
            <DateInput name="nextReminderDate" />
          </Field>
        </div>
      </FormSection>
      <FormError state={state} />
      <FormActions>
        <Button type="button" variant="ghost" onClick={() => router.push(back)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save follow-up"}
        </Button>
      </FormActions>
    </form>
  );
}
