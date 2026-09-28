"use client";

import { startTransition, useActionState } from "react";
import type { FormState } from "@/lib/action";

/**
 * useActionState without React's reset-on-submit, so a rejected form keeps what the user typed.
 * `action` is a server action (state, formData) → FormState.
 */
export function useFormAction(action: (state: FormState, form: FormData) => Promise<FormState>) {
  const [state, dispatch, pending] = useActionState(action, undefined);
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => dispatch(data));
  };
  return { state, onSubmit, pending };
}

export function FormError({ state }: { state: FormState }) {
  if (!state?.error) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {state.error}
    </p>
  );
}
