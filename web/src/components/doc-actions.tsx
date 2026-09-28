"use client";

import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Field, FormError, useFormAction } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";

// Buttons for a document's detail page (Send, Approve, Issue, Cancel, Email …). Each runs a server action and toasts
// its outcome; "Sent for approval." (A§7) comes back as the message.

type Action = (state: FormState, form: FormData) => Promise<FormState>;
type Variant = "default" | "outline" | "destructive";

function useToasted(action: Action, done: string, after?: () => void) {
  const form = useFormAction(action);
  const { state } = form;
  useEffect(() => {
    if (state?.error) toast.error(state.error);
    else if (state?.ok) {
      toast.success(state.message ?? done);
      after?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new result arrives
  }, [state]);
  return form;
}

/** One click, one server action. */
export function ActionButton({
  action,
  label,
  done,
  variant = "outline",
}: {
  action: Action;
  label: string;
  done: string;
  variant?: Variant;
}) {
  const { onSubmit, pending } = useToasted(action, done);
  return (
    <form onSubmit={onSubmit}>
      <Button type="submit" variant={variant} disabled={pending}>
        {pending ? "Working…" : label}
      </Button>
    </form>
  );
}

/** A confirm dialog (Issue, Cancel …), optionally asking for a reason (sent with an approval request). */
export function ActionDialog({
  action,
  label,
  title,
  description,
  confirmLabel,
  done,
  reason,
  variant = "outline",
  children,
}: {
  action: Action;
  label: string;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  done: string;
  reason?: boolean;
  variant?: Variant;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { state, onSubmit, pending } = useToasted(action, done, () => setOpen(false));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant}>{label}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4">
          {children}
          {reason && (
            <Field label="Reason" hint="Kept with the record (and shown to the owner if it needs approval).">
              <Textarea name="reason" rows={2} maxLength={500} />
            </Field>
          )}
          <FormError state={state} />
          <DialogFooter>
            <Button type="submit" variant={variant === "destructive" ? "destructive" : "default"} disabled={pending}>
              {pending ? "Working…" : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Email the PDF (D07): to, subject and message, filled in and editable. */
export function EmailDialog({
  action,
  to,
  subject,
  message,
}: {
  action: Action;
  to: string;
  subject: string;
  message: string;
}) {
  return (
    <ActionDialog action={action} label="Email" title="Email the PDF" confirmLabel="Send email" done="Email sent.">
      <Field label="To">
        <Input name="to" type="email" defaultValue={to} required maxLength={200} />
      </Field>
      <Field label="Subject">
        <Input name="subject" defaultValue={subject} required maxLength={200} />
      </Field>
      <Field label="Message" hint="The PDF is attached.">
        <Textarea name="message" rows={5} defaultValue={message} maxLength={4000} />
      </Field>
    </ActionDialog>
  );
}
