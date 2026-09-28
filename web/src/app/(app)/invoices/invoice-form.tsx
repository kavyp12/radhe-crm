"use client";

import { useEffect, useState } from "react";
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
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import { gstMode, type LineText } from "@/lib/lines";

export type InvoiceFormValues = {
  kind: "tax" | "estimate";
  customerId: string;
  date: string;
  terms: string;
  notes: string;
  lines: LineText[];
};

type Props = {
  values: InvoiceFormValues;
  customers: CustomerOption[];
  categories: CategoryOption[];
  companyState: string;
  /** Lines billed from jobs / a quotation: the customer stays. */
  customerLocked?: boolean;
  submitLabel: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
};

export function InvoiceForm({ values: v, customers, categories, companyState, customerLocked, submitLabel, action }: Props) {
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);
  const [customerId, setCustomerId] = useState(v.customerId);
  const [kind, setKind] = useState(v.kind);
  const [rows, setRows] = useLineRows(v.lines);
  const customer = customers.find((c) => String(c.id) === customerId);
  const mode = gstMode(customer?.stateCode ?? companyState, companyState, kind === "estimate");

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
        <div className="grid grid-cols-1 gap-4">
          <FormSection title="Invoice" description="Saved as a draft. The number comes when it is issued.">
            <div className="grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)_180px]">
              <Field label="Kind" error={error("kind")}>
                <NativeSelect name="kind" value={kind} onChange={(e) => setKind(e.target.value as "tax" | "estimate")} className="w-full">
                  <NativeSelectOption value="tax">Tax Invoice</NativeSelectOption>
                  <NativeSelectOption value="estimate">Estimate (no GST)</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field label="Customer" hint={customerLocked ? "Fixed: the lines are billed from its jobs / quotation." : undefined} error={error("customerId")}>
                <CustomerSelect customers={customers} value={customerId} onChange={setCustomerId} disabled={customerLocked} />
              </Field>
              <Field label="Date" hint="Due date = date + the customer's credit days." error={error("date")}>
                <DateInput name="date" defaultValue={v.date} required />
              </Field>
            </div>
            {customerLocked && <input type="hidden" name="customerId" value={customerId} />}
          </FormSection>
          <FormSection
            title="Items"
            description={
              mode === "estimate" ? "Estimate: no GST." : mode === "same_state" ? "Same state: CGST + SGST." : "Other state: IGST."
            }
          >
            <LinesEditor rows={rows} setRows={setRows} categories={categories} />
            {error("lines") && <p className="mt-2 text-sm text-destructive">{error("lines")}</p>}
          </FormSection>
          <FormSection title="Terms and notes">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Terms" hint="Printed on the PDF." error={error("terms")}>
                <Textarea name="terms" rows={4} defaultValue={v.terms} />
              </Field>
              <Field label="Notes" hint="Internal, not printed." error={error("notes")}>
                <Textarea name="notes" rows={4} defaultValue={v.notes} />
              </Field>
            </div>
          </FormSection>
        </div>
        <div className="lg:sticky lg:top-4">
          <LinesTotals rows={rows} categories={categories} mode={mode} />
        </div>
      </div>
      <FormError state={state} />
      <FormActions>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </FormActions>
    </form>
  );
}
