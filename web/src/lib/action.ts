import { parseMoney } from "@/lib/num";

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

// Form fields as typed → values, or a UserError naming the field.

/** Trimmed text; blank = null. */
export function formText(value: string, field: string, max = 200): string | null {
  const v = value.trim();
  if (v.length > max) throw new UserError(`Keep this under ${max} characters.`, field);
  return v || null;
}

/** A whole number of days; blank = null. */
export function formDays(value: string, field: string): number | null {
  const v = value.trim();
  if (!v) return null;
  if (!/^\d{1,4}$/.test(v)) throw new UserError("Enter a whole number of days.", field);
  return Number(v);
}

/** A mobile / phone number: digits, spaces, dashes, an optional leading +; blank = null. */
export function formPhone(value: string, field: string): string | null {
  const phone = formText(value, field, 20);
  if (phone && !/^\+?[\d\s-]{6,20}$/.test(phone)) throw new UserError("Enter a phone number (digits, spaces, +).", field);
  return phone;
}

/** Rupees → paise, minus allowed (never rounds); blank = null. */
export function formMoney(value: string, field: string): bigint | null {
  if (!value.trim()) return null;
  try {
    return parseMoney(value);
  } catch {
    throw new UserError("Enter an amount like 1,00,000.50 (up to 2 decimals).", field);
  }
}
