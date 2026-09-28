/** A message for the person filling the form ("That username is taken."). Any other error is a bug and still throws. */
export class UserError extends Error {}

export type FormState = { error?: string; ok?: boolean } | undefined;

/** Server actions used with useActionState: a UserError becomes { error } for the form. */
export async function formAction(fn: () => Promise<unknown>): Promise<FormState> {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    if (e instanceof UserError) return { error: e.message };
    throw e;
  }
}
