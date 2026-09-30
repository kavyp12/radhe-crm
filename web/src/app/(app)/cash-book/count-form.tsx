"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Field, FormError, useFormAction } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/lib/action";

/** Enter the cash counted: saved as a new count (a recount is another row); nothing posts until asked. */
export function CountForm({ action }: { action: (state: FormState, form: FormData) => Promise<FormState> }) {
  const { state, onSubmit, pending } = useFormAction(action);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
    else if (state?.ok) {
      toast.success(state.message ?? "Count saved.");
      form.current?.reset();
    }
  }, [state]);
  return (
    <form ref={form} onSubmit={onSubmit} className="grid gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Cash counted (₹)" error={state?.field === "counted" ? state.error : undefined} className="w-44">
          <Input name="counted" inputMode="decimal" required className="text-right tabular-nums" />
        </Field>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Save count"}
        </Button>
      </div>
      {state?.field !== "counted" && <FormError state={state} />}
    </form>
  );
}
