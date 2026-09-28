"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { Field, useFormAction } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";

type Props = {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  /** Set once decided ("Rejected by Ronnie, 28/09/2026 06:53 PM"); the form then shows it instead. */
  decided: { text: string; note: string | null } | null;
};

// One component for both states, so it stays mounted when the page re-renders as decided and the toast still shows.
export function DecisionForm({ action, decided }: Props) {
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.ok) toast.success(state.message ?? "Saved.");
    else if (state?.error) toast.error(state.error);
  }, [state]);

  if (decided) {
    return (
      <div className="grid gap-2 text-sm">
        <p>{decided.text}</p>
        {decided.note && <p className="whitespace-pre-line text-muted-foreground">{decided.note}</p>}
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <Field label="Note (optional)" error={state?.error}>
        <Textarea name="note" rows={2} maxLength={1000} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" name="decision" value="approve" disabled={pending}>
          Approve
        </Button>
        <Button type="submit" name="decision" value="reject" variant="outline" disabled={pending}>
          Reject
        </Button>
      </div>
    </form>
  );
}
