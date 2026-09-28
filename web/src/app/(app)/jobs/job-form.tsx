"use client";

import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { DateInput } from "@/components/date-input";
import { Field, FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import {
  CustomerSelect,
  LinesEditor,
  LinesTotals,
  useLineRows,
  type CategoryOption,
  type CustomerOption,
} from "@/components/sales-lines";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import { gstMode, type LineText } from "@/lib/lines";

export type JobFormValues = {
  customerId: string;
  date: string;
  targetDate: string;
  salesPersonId: string;
  siteAddress: string;
  siteReference: string;
  vehicleNo: string;
  notes: string;
  lines: LineText[];
};

type Props = {
  values: JobFormValues;
  customers: CustomerOption[];
  categories: CategoryOption[];
  companyState: string;
  staff: { id: string; name: string }[];
  /** From a quotation: its lines, shown read-only (copied on the server), instead of the lines editor. */
  preview?: ReactNode;
  /** Editing: the customer stays. */
  customerLocked?: boolean;
  submitLabel: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
};

export function JobForm({ values: v, customers, categories, companyState, staff, preview, customerLocked, submitLabel, action }: Props) {
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);
  const [customerId, setCustomerId] = useState(v.customerId);
  const [rows, setRows] = useLineRows(v.lines);
  const customer = customers.find((c) => String(c.id) === customerId);
  const mode = gstMode(customer?.stateCode ?? companyState, companyState);

  const details = (
    <FormSection title="Job">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {!preview && (
          <Field label="Customer" error={error("customerId")} className="sm:col-span-2">
            <CustomerSelect customers={customers} value={customerId} onChange={setCustomerId} disabled={customerLocked} />
          </Field>
        )}
        <Field label="Job date" error={error("date")}>
          <DateInput name="date" defaultValue={v.date} required />
        </Field>
        <Field label="Target date" hint="When it should be ready." error={error("targetDate")}>
          <DateInput name="targetDate" defaultValue={v.targetDate || undefined} />
        </Field>
        <Field label="Sales person" error={error("salesPersonId")}>
          <NativeSelect name="salesPersonId" defaultValue={v.salesPersonId} className="w-full">
            <NativeSelectOption value="">—</NativeSelectOption>
            {staff.map((u) => (
              <NativeSelectOption key={u.id} value={u.id}>
                {u.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Vehicle no" error={error("vehicleNo")}>
          <Input name="vehicleNo" defaultValue={v.vehicleNo} maxLength={30} autoCapitalize="characters" />
        </Field>
        <Field label="Site address" hint="Blank = the customer's site address." error={error("siteAddress")} className="sm:col-span-2">
          <Textarea name="siteAddress" rows={2} defaultValue={v.siteAddress} />
        </Field>
        <Field label="Site reference" hint="Landmark, contact at site…" error={error("siteReference")}>
          <Input name="siteReference" defaultValue={v.siteReference} maxLength={200} />
        </Field>
        <Field label="Notes" error={error("notes")} className="sm:col-span-2 lg:col-span-3">
          <Textarea name="notes" rows={2} defaultValue={v.notes} />
        </Field>
      </div>
      {customerLocked && <input type="hidden" name="customerId" value={customerId} />}
    </FormSection>
  );

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4">
      {preview ? (
        <>
          {details}
          <FormSection title="Items" description="Copied from the quotation as they are.">
            {preview}
          </FormSection>
        </>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
          <div className="grid grid-cols-1 gap-4">
            {details}
            <FormSection title="Items">
              <LinesEditor rows={rows} setRows={setRows} categories={categories} />
              {error("lines") && <p className="mt-2 text-sm text-destructive">{error("lines")}</p>}
            </FormSection>
          </div>
          <div className="lg:sticky lg:top-4">
            <LinesTotals rows={rows} categories={categories} mode={mode} />
          </div>
        </div>
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
