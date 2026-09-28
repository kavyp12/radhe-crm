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

export type FormState = { error?: string; field?: string; ok?: boolean; message?: string } | undefined;

/**
 * Server actions used with useActionState: a UserError becomes { error, field } for the form. If `fn` returns
 * { message } (e.g. runOrRequest's "Sent for approval."), the form shows that instead of its usual success text.
 */
export async function formAction(fn: () => Promise<unknown>): Promise<FormState> {
  try {
    const message = ((await fn()) as { message?: unknown } | undefined)?.message;
    return { ok: true, message: typeof message === "string" ? message : undefined };
  } catch (e) {
    if (e instanceof UserError) return { error: e.message, field: e.field };
    throw e;
  }
}
