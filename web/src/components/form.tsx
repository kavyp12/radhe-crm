"use client";

import { cloneElement, startTransition, useActionState, useId, type ReactElement } from "react";
import { Label } from "@/components/ui/label";
import type { FormState } from "@/lib/action";
import { cn } from "@/lib/utils";

/**
 * useActionState without React's reset-on-submit, so a rejected form keeps what the user typed.
 * `action` is a server action (state, formData) → FormState.
 */
export function useFormAction(action: (state: FormState, form: FormData) => Promise<FormState>) {
  const [state, dispatch, pending] = useActionState(action, undefined);
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Like a native submit, the clicked button's name / value is sent too.
    const data = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
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

/** A titled card section of a form (DESIGN.md "Form"). */
export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Save Draft / Issue buttons, stuck to the bottom of the scrolling page. */
export function FormActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-2 flex items-center justify-end gap-2 border-t bg-card/95 px-4 py-3 backdrop-blur supports-backdrop-filter:bg-card/80 md:-mx-6 md:px-6">
      {children}
    </div>
  );
}

/**
 * A labelled field: the label wraps the input, then an inline error (DESIGN: errors under the field) or a hint.
 * The single child input gets aria-invalid / aria-describedby.
 */
export function Field({
  label,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  className?: string;
  children: ReactElement<{ "aria-invalid"?: boolean; "aria-describedby"?: string }>;
}) {
  const noteId = useId();
  const note = error ?? hint;
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <Label className="grid gap-1.5">
        {label}
        {cloneElement(children, {
          "aria-invalid": error ? true : undefined,
          "aria-describedby": note ? noteId : undefined,
        })}
      </Label>
      {note && (
        <p id={noteId} className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
          {note}
        </p>
      )}
    </div>
  );
}
