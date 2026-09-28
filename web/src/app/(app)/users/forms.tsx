"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FormError, useFormAction } from "@/components/form";
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
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { FormState } from "@/lib/action";
import { DEFAULT_CAN_VIEW_COST, ROLE_LABEL, ROLES, type Role } from "@/lib/permissions";
import { createUserAction } from "./actions";

type Action = (state: FormState, form: FormData) => Promise<FormState>;

function RoleSelect(props: React.ComponentProps<typeof NativeSelect>) {
  return (
    <NativeSelect name="role" className="w-full" {...props}>
      {ROLES.map((role) => (
        <NativeSelectOption key={role} value={role}>
          {ROLE_LABEL[role]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

function CostCheckbox(props: React.ComponentProps<"input">) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name="canViewCost" className="size-4 accent-primary" {...props} />
      Can see cost, profit and purchase rates
    </label>
  );
}

export function NewUserDialog() {
  const { state, onSubmit, pending } = useFormAction(createUserAction);
  const [role, setRole] = useState<Role>("sales");
  const [canViewCost, setCanViewCost] = useState(DEFAULT_CAN_VIEW_COST.sales);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>New user</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
          <DialogDescription>They sign in with this username and password.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4">
          <Label className="grid gap-1.5">
            Name
            <Input name="name" required />
          </Label>
          <Label className="grid gap-1.5">
            Username
            <Input name="username" required autoCapitalize="none" spellCheck={false} pattern="[A-Za-z0-9_.]{3,30}" />
          </Label>
          <Label className="grid gap-1.5">
            Role
            <RoleSelect
              value={role}
              onChange={(e) => {
                const next = e.target.value as Role;
                setRole(next);
                setCanViewCost(DEFAULT_CAN_VIEW_COST[next]);
              }}
            />
          </Label>
          <CostCheckbox checked={canViewCost} onChange={(e) => setCanViewCost(e.target.checked)} />
          <Label className="grid gap-1.5">
            Password
            <Input name="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" />
          </Label>
          <FormError state={state} />
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              Create user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type EditableUser = { role: Role; canViewCost: boolean; active: boolean };

/** `self`: the owner's own account — role and active stay as they are. */
export function EditUserForm({ user, self, action }: { user: EditableUser; self: boolean; action: Action }) {
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.ok) toast.success("Saved.");
  }, [state]);

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <Label className="grid gap-1.5">
        Role
        <RoleSelect defaultValue={user.role} disabled={self} />
      </Label>
      <CostCheckbox defaultChecked={user.canViewCost} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="active" defaultChecked={user.active} disabled={self} className="size-4 accent-primary" />
        Active (can sign in)
      </label>
      {self && (
        <>
          <input type="hidden" name="role" value={user.role} />
          <input type="hidden" name="active" value="on" />
          <p className="text-xs text-muted-foreground">You can&apos;t change your own role or disable your own account.</p>
        </>
      )}
      <FormError state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}

export function ResetPasswordForm({ action }: { action: Action }) {
  const { state, onSubmit, pending } = useFormAction(action);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!state?.ok) return;
    form.current?.reset();
    toast.success("Password changed. They have been signed out everywhere.");
  }, [state]);

  return (
    <form ref={form} onSubmit={onSubmit} className="grid gap-4">
      <Label className="grid gap-1.5">
        New password
        <Input name="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" />
      </Label>
      <FormError state={state} />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          Reset password
        </Button>
      </div>
    </form>
  );
}
