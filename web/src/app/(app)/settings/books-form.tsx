"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { Field, FormSection, useFormAction } from "@/components/form";
import { DateInput } from "@/components/date-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/lib/action";

type MoneyAccount = { id: number; code: string; name: string; opening: string };

type Props = {
  booksStartDate: string | null;
  /** Documents have posted: the date can no longer change (D43). */
  locked: boolean;
  accounts: MoneyAccount[];
  action: (state: FormState, form: FormData) => Promise<FormState>;
};

export function BooksForm({ booksStartDate, locked, accounts, action }: Props) {
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.ok) toast.success("Books saved.");
    else if (state?.error) toast.error(state.error);
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4">
      <FormSection
        title="Books start date"
        description="Every opening balance (money accounts, customers, vendors) is posted on this date."
      >
        <Field
          label="Books start date"
          hint={locked ? "Locked: documents have been posted. No document can be dated before it." : undefined}
          error={error("booksStartDate")}
          className="sm:max-w-60"
        >
          <DateInput name="booksStartDate" defaultValue={booksStartDate ?? undefined} readOnly={locked} />
        </Field>
      </FormSection>

      <FormSection
        title="Money accounts"
        description="Rename them to match your bank. Opening balance = the amount on the books start date (minus for an overdraft)."
      >
        <div className="grid gap-4">
          {accounts.map((a) => (
            <div key={a.id} className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="id" value={a.id} />
              <Field label={`Account ${a.code}`} error={error(`name.${a.id}`)}>
                <Input name="name" defaultValue={a.name} maxLength={60} required />
              </Field>
              <Field label="Opening balance (₹)" error={error(`opening.${a.id}`)}>
                <Input name="opening" defaultValue={a.opening} inputMode="decimal" placeholder="0.00" className="tabular-nums" />
              </Field>
            </div>
          ))}
        </div>
      </FormSection>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save books"}
        </Button>
      </div>
    </form>
  );
}
