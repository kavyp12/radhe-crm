"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { Field, FormActions, FormSection, useFormAction } from "@/components/form";
import { GstinStateFields } from "@/components/gstin-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";

export type CustomerFormValues = {
  name: string;
  firmName: string;
  mobile: string;
  gstin: string;
  stateCode: string;
  billingAddress: string;
  siteAddress: string;
  creditLimit: string;
  creditDays: string;
  isCreditCustomer: boolean;
  salesPersonId: string;
  collectionPersonId: string;
  notes: string;
  openingBalance: string;
  active: boolean;
};

type Props = {
  values: CustomerFormValues;
  staff: { id: string; name: string }[];
  /** Owner / accountant (D40); the server checks again. */
  canSetOpening: boolean;
  /** Edit form, owner / accountant. */
  canDeactivate: boolean;
  submitLabel: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
};

function PersonSelect({ name, value, staff }: { name: string; value: string; staff: Props["staff"] }) {
  return (
    <NativeSelect name={name} defaultValue={value} className="w-full">
      <NativeSelectOption value="">—</NativeSelectOption>
      {staff.map((u) => (
        <NativeSelectOption key={u.id} value={u.id}>
          {u.name}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

export function CustomerForm({ values: v, staff, canSetOpening, canDeactivate, submitLabel, action }: Props) {
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4">
      <FormSection title="Customer">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Customer name" error={error("name")}>
            <Input name="name" defaultValue={v.name} required maxLength={200} />
          </Field>
          <Field label="Firm name" error={error("firmName")}>
            <Input name="firmName" defaultValue={v.firmName} maxLength={200} />
          </Field>
          <Field label="Mobile" error={error("mobile")}>
            <Input name="mobile" type="tel" defaultValue={v.mobile} maxLength={20} />
          </Field>
          <GstinStateFields gstin={v.gstin} stateCode={v.stateCode} error={error} />
        </div>
      </FormSection>

      <FormSection title="Addresses">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Billing address" error={error("billingAddress")}>
            <Textarea name="billingAddress" rows={3} defaultValue={v.billingAddress} />
          </Field>
          <Field label="Delivery / site address" error={error("siteAddress")}>
            <Textarea name="siteAddress" rows={3} defaultValue={v.siteAddress} />
          </Field>
        </div>
      </FormSection>

      <FormSection title="Credit and people">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Credit limit (₹)" hint="Blank = no limit." error={error("creditLimit")}>
            <Input name="creditLimit" defaultValue={v.creditLimit} inputMode="decimal" className="tabular-nums" />
          </Field>
          <Field label="Credit days" hint="Days to pay after the invoice date." error={error("creditDays")}>
            <Input name="creditDays" defaultValue={v.creditDays} inputMode="numeric" className="tabular-nums" />
          </Field>
          <Field label="Sales person" error={error("salesPersonId")}>
            <PersonSelect name="salesPersonId" value={v.salesPersonId} staff={staff} />
          </Field>
          <Field label="Collection person" error={error("collectionPersonId")}>
            <PersonSelect name="collectionPersonId" value={v.collectionPersonId} staff={staff} />
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="isCreditCustomer" defaultChecked={v.isCreditCustomer} className="size-4 accent-primary" />
            Credit customer (unpaid print jobs show as Credit Customer, not Unpaid)
          </label>
        </div>
      </FormSection>

      {canSetOpening && (
        <FormSection title="Opening balance" description="What stood on the books start date. Posted to the journal.">
          <Field
            label="Opening balance (₹)"
            hint="Plus = the customer owes us (Dr). Minus = we owe them or hold an advance (Cr)."
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
              Active (inactive customers stay on record, with their history)
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
