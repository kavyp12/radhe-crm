"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { Field, FormActions, FormSection, useFormAction } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import type { Settings } from "@/lib/settings";

type Props = {
  settings: Settings;
  /** Stored discount limit as percent text ("10", "12.5"). */
  discountLimit: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
};

export function SettingsForm({ settings: s, discountLimit, action }: Props) {
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.ok) toast.success("Settings saved.");
    else if (state?.error) toast.error(state.error);
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4">
      <FormSection title="Company" description="Printed on invoices, quotations and statements.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company name" error={error("companyName")}>
            <Input name="companyName" defaultValue={s.companyName ?? ""} />
          </Field>
          <Field label="GSTIN" error={error("gstin")}>
            <Input
              name="gstin"
              defaultValue={s.gstin ?? ""}
              maxLength={15}
              autoCapitalize="characters"
              className="uppercase"
            />
          </Field>
          <Field label="Address" error={error("address")} className="sm:col-span-2">
            <Textarea name="address" rows={3} defaultValue={s.address ?? ""} />
          </Field>
          <Field label="State code" hint="24 is Gujarat." error={error("stateCode")}>
            <Input name="stateCode" defaultValue={s.stateCode} inputMode="numeric" maxLength={2} required />
          </Field>
          <Field label="Phone" error={error("phone")}>
            <Input name="phone" type="tel" defaultValue={s.phone ?? ""} />
          </Field>
          <Field label="Email" error={error("email")}>
            <Input name="email" type="email" defaultValue={s.email ?? ""} />
          </Field>
        </div>
      </FormSection>

      <FormSection title="Bank and UPI" description="Shown on invoices so customers know where to pay.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bank details" error={error("bankDetails")}>
            <Textarea
              name="bankDetails"
              rows={3}
              defaultValue={s.bankDetails ?? ""}
              placeholder="Bank, account number, IFSC, branch"
            />
          </Field>
          <Field label="UPI id" error={error("upiId")}>
            <Input name="upiId" defaultValue={s.upiId ?? ""} placeholder="name@bank" autoCapitalize="none" />
          </Field>
        </div>
      </FormSection>

      <FormSection title="Terms" description="Printed at the foot of the PDF; each document can change its own copy.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Invoice terms" error={error("invoiceTerms")}>
            <Textarea name="invoiceTerms" rows={4} defaultValue={s.invoiceTerms ?? ""} />
          </Field>
          <Field label="Quotation terms" error={error("quotationTerms")}>
            <Textarea name="quotationTerms" rows={4} defaultValue={s.quotationTerms ?? ""} />
          </Field>
        </div>
      </FormSection>

      <FormSection title="Approval rules" description="When an entry by someone other than the owner needs the owner's approval.">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Discount limit (%)" hint="A bigger discount needs approval." error={error("discountLimit")}>
            <Input name="discountLimit" defaultValue={discountLimit} inputMode="decimal" />
          </Field>
          <Field
            label="Backdate days"
            hint="Entries dated more than this many days back need approval."
            error={error("backdateDays")}
          >
            <Input name="backdateDays" defaultValue={s.backdateDays ?? ""} inputMode="numeric" />
          </Field>
          <Field
            label="Default credit days"
            hint="Days of credit given unless set otherwise."
            error={error("defaultCreditDays")}
          >
            <Input name="defaultCreditDays" defaultValue={s.defaultCreditDays ?? ""} inputMode="numeric" />
          </Field>
        </div>
      </FormSection>

      <FormActions>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
      </FormActions>
    </form>
  );
}
