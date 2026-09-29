"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { Field, FormActions, FormSection, useFormAction } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { FormState } from "@/lib/action";

/** Suggestions only: the unit is free text, one per item, no conversion (D20). */
const UNITS = ["Nos", "Sheet", "Sq Ft", "Rft", "Mtr", "Kg", "Roll", "Litre", "Set"];

export type ItemFormValues = {
  name: string;
  unit: string;
  categoryId: string;
  hsnSac: string;
  gstPercent: string;
  openingQty: string;
  openingRate: string;
  active: boolean;
};

type Props = {
  values: ItemFormValues;
  categories: { id: number; name: string }[];
  /** Owner / accountant who see cost (D40, D51); the server checks again. */
  canSetOpening: boolean;
  canDeactivate: boolean;
  submitLabel: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
};

export function ItemForm({ values: v, categories, canSetOpening, canDeactivate, submitLabel, action }: Props) {
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4">
      <FormSection title="Item">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={error("name")}>
            <Input name="name" defaultValue={v.name} required maxLength={100} />
          </Field>
          <Field label="Category" hint="An expense category (Acrylic, ACP …)." error={error("categoryId")}>
            <NativeSelect name="categoryId" defaultValue={v.categoryId} className="w-full" required>
              <NativeSelectOption value="">Pick a category…</NativeSelectOption>
              {categories.map((c) => (
                <NativeSelectOption key={c.id} value={String(c.id)}>
                  {c.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Unit" hint="Purchases and issues are entered in this unit." error={error("unit")}>
            <Input name="unit" defaultValue={v.unit} list="stock-units" maxLength={20} placeholder="Nos" />
          </Field>
          <datalist id="stock-units">
            {UNITS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
          <Field label="HSN / SAC" hint="4 to 8 digits; blank if not known yet." error={error("hsnSac")}>
            <Input name="hsnSac" defaultValue={v.hsnSac} inputMode="numeric" maxLength={8} className="tabular-nums" />
          </Field>
          <Field label="GST %" hint="Fills purchase bill lines; blank = type it on each line." error={error("gstPercent")}>
            <Input name="gstPercent" defaultValue={v.gstPercent} inputMode="decimal" className="tabular-nums" />
          </Field>
        </div>
      </FormSection>

      {canSetOpening && (
        <FormSection title="Opening stock" description="What was in stock on the books start date, at its cost. Posted to the journal.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Opening qty" error={error("openingQty")}>
              <Input name="openingQty" defaultValue={v.openingQty} inputMode="decimal" placeholder="0" className="tabular-nums" />
            </Field>
            <Field label="Rate per unit (₹)" error={error("openingRate")}>
              <Input name="openingRate" defaultValue={v.openingRate} inputMode="decimal" placeholder="0.00" className="tabular-nums" />
            </Field>
          </div>
        </FormSection>
      )}

      {canDeactivate && (
        <FormSection title="Status">
          <label className="flex items-center gap-2 text-sm">
            <input type="hidden" name="activeShown" value="1" />
            <input type="checkbox" name="active" defaultChecked={v.active} className="size-4 accent-primary" />
            Active (inactive items stay on record, with their stock card)
          </label>
          {error("active") && <p className="mt-1 text-xs text-destructive">{error("active")}</p>}
        </FormSection>
      )}

      <FormActions>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </FormActions>
    </form>
  );
}
