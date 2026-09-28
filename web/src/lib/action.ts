/**
 * A message for the person filling the form ("That username is taken."), optionally tied to one field by its
 * form name. Any other error is a bug and still throws.
 */
export class UserError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export type FormState = { error?: string; field?: string; ok?: boolean } | undefined;

/** Server actions used with useActionState: a UserError becomes { error, field } for the form. */
export async function formAction(fn: () => Promise<unknown>): Promise<FormState> {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    if (e instanceof UserError) return { error: e.message, field: e.field };
    throw e;
  }
}
