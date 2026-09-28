"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import type { Role } from "@/lib/permissions";
import { createUser, resetPassword, updateUser } from "@/lib/users";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

export async function createUserAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("users", "create");
  return formAction(async () => {
    const id = await createUser(actor, {
      name: text(form, "name"),
      username: text(form, "username"),
      role: text(form, "role") as Role,
      canViewCost: form.get("canViewCost") === "on",
      password: text(form, "password"),
    });
    redirect(`/users/${id}`);
  });
}

export async function updateUserAction(id: string, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("users", "edit");
  return formAction(async () => {
    await updateUser(actor, id, {
      role: text(form, "role") as Role,
      canViewCost: form.get("canViewCost") === "on",
      active: form.get("active") === "on",
    });
    revalidatePath("/users", "layout");
  });
}

export async function resetPasswordAction(id: string, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("users", "edit");
  return formAction(() => resetPassword(actor, id, text(form, "password")));
}
