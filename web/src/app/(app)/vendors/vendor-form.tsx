"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { Field, FormActions, FormSection, useFormAction } from "@/components/form";
import { GstinStateFields, useDuplicateCheck } from "@/components/gstin-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";

export type VendorFormValues = {
  name: string;
  gstin: string;
  stateCode: string;
  mobile: string;
  address: string;
  creditDays: string;
  notes: string;
  openingBalance: string;
  active: boolean;
};

type Props = {
  values: VendorFormValues;
  /** Owner / accountant (D40); the server checks again. */
  canSetOpening: boolean;
  /** Edit form only. */
  canDeactivate: boolean;
  submitLabel: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
  /** Server action: the duplicate GSTIN / mobile warning, or null. */
  duplicates: (gstin: string, mobile: string) => Promise<string | null>;
};

export function VendorForm({ values: v, canSetOpening, canDeactivate, submitLabel, action, duplicates }: Props) {
  const { state, onSubmit, pending } = useFormAction(action);
  const { onBlur, warning } = useDuplicateCheck(duplicates);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);

  return (
    <form onSubmit={onSubmit} onBlur={onBlur} className="grid grid-cols-1 gap-4">
      <FormSection title="Vendor">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Vendor name" error={error("name")}>
            <Input name="name" defaultValue={v.name} required maxLength={200} />
          </Field>
          <Field label="Mobile" error={error("mobile")}>
            <Input name="mobile" type="tel" defaultValue={v.mobile} maxLength={20} />
          </Field>
          <GstinStateFields gstin={v.gstin} stateCode={v.stateCode} error={error} />
          {warning && <div className="sm:col-span-2">{warning}</div>}
          <Field label="Address" error={error("address")}>
            <Textarea name="address" rows={3} defaultValue={v.address} />
          </Field>
          <Field label="Credit days" hint="Days we get to pay their bills." error={error("creditDays")}>
            <Input name="creditDays" defaultValue={v.creditDays} inputMode="numeric" className="tabular-nums" />
          </Field>
        </div>
      </FormSection>

      {canSetOpening && (
        <FormSection title="Opening balance" description="What stood on the books start date. Posted to the journal.">
          <Field
            label="Opening balance (₹)"
            hint="Plus = we owe them (Cr). Minus = they owe us or hold our advance (Dr)."
            error={error("openingBalance")}
            className="sm:max-w-80"
          >
            <Input name="openingBalance" defaultValue={v.openingBalance} inputMode="decimal" placeholder="0.00" className="tabular-nums" />
          </Field>
        </FormSection>
      )}

      <FormSection title="Notes">
        <div className="grid gap-4">
          <Field label="Notes" error={error("notes")}>
            <Textarea name="notes" rows={3} defaultValue={v.notes} />
          </Field>
          {canDeactivate && (
            <label className="flex items-center gap-2 text-sm">
              <input type="hidden" name="activeShown" value="1" />
              <input type="checkbox" name="active" defaultChecked={v.active} className="size-4 accent-primary" />
              Active (inactive vendors stay on record, with their history)
            </label>
          )}
          {error("active") && <p className="text-xs text-destructive">{error("active")}</p>}
        </div>
      </FormSection>

      <FormActions>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </FormActions>
    </form>
  );
}
