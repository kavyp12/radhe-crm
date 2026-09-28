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
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import { gstMode, type LineText } from "@/lib/lines";

export type QuotationFormValues = { customerId: string; date: string; terms: string; notes: string; lines: LineText[] };

type Props = {
  values: QuotationFormValues;
  customers: CustomerOption[];
  categories: CategoryOption[];
  companyState: string;
  submitLabel: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
};

export function QuotationForm({ values: v, customers, categories, companyState, submitLabel, action }: Props) {
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);
  const [customerId, setCustomerId] = useState(v.customerId);
  const [rows, setRows] = useLineRows(v.lines);
  const customer = customers.find((c) => String(c.id) === customerId);
  const mode = gstMode(customer?.stateCode ?? companyState, companyState);

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
        <div className="grid grid-cols-1 gap-4">
          <FormSection title="Quotation">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
              <Field label="Customer" error={error("customerId")}>
                <CustomerSelect customers={customers} value={customerId} onChange={setCustomerId} />
              </Field>
              <Field label="Date" error={error("date")}>
                <DateInput name="date" defaultValue={v.date} required />
              </Field>
            </div>
          </FormSection>
          <FormSection
            title="Items"
            description={`${mode === "same_state" ? "Same state: CGST + SGST" : "Other state: IGST"}. With unit Sq Ft, W × H fills the qty.`}
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
