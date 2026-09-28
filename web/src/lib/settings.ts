import { and, eq } from "drizzle-orm";
import { db, writeTx } from "@/db";
import { accounts, attachments, settings } from "@/db/schema";
import { UserError } from "@/lib/action";
import { parseDate } from "@/lib/dates";
import { liveOpenings, moveOpenings, setOpening } from "@/lib/ledger";
import { bpText, parseMoney } from "@/lib/num";
import { can, type SessionUser } from "@/lib/permissions";

// Company settings (A§2): one row, owner only. Blank fields are stored as null ("not set yet").

export type Settings = typeof settings.$inferSelect;

/** The form's fields, as typed. */
export type SettingsInput = {
  companyName: string;
  address: string;
  gstin: string;
  stateCode: string;
  phone: string;
  email: string;
  bankDetails: string;
  upiId: string;
  invoiceTerms: string;
  discountLimit: string; // percent, e.g. "10" or "12.5"
  backdateDays: string;
  defaultCreditDays: string;
};

export async function getSettings(): Promise<Settings> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1));
  return row;
}

/** The stored discount limit back as form text: 1000 bp → "10", null → "". */
export const percentText = (bp: number | null) => (bp === null ? "" : bpText(bp));

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function text(value: string, field: string, max = 200): string | null {
  const v = value.trim();
  if (v.length > max) throw new UserError(`Keep this under ${max} characters.`, field);
  return v || null;
}

function days(value: string, field: string): number | null {
  const v = value.trim();
  if (!v) return null;
  if (!/^\d{1,4}$/.test(v)) throw new UserError("Enter a whole number of days.", field);
  return Number(v);
}

export async function updateSettings(actor: SessionUser, input: SettingsInput): Promise<void> {
  if (!can(actor, "settings", "edit")) throw new Error("Not allowed");

  const stateCode = input.stateCode.trim();
  if (!/^\d{2}$/.test(stateCode)) throw new UserError("State code is two digits, e.g. 24 for Gujarat.", "stateCode");
  const gstin = text(input.gstin.toUpperCase(), "gstin", 15);
  if (gstin && !GSTIN.test(gstin)) throw new UserError("GSTIN is 15 characters, e.g. 24ABCDE1234F1Z5.", "gstin");
  if (gstin && !gstin.startsWith(stateCode)) {
    throw new UserError(`A GSTIN for state ${stateCode} starts with ${stateCode}.`, "gstin");
  }
  const email = text(input.email, "email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError("Enter a valid email.", "email");
  const upiId = text(input.upiId, "upiId");
  if (upiId && !/^[\w.-]+@[\w.-]+$/.test(upiId)) throw new UserError("A UPI id looks like name@bank.", "upiId");

  let discountLimitBp: number | null = null;
  if (input.discountLimit.trim()) {
    try {
      discountLimitBp = Number(parseMoney(input.discountLimit)); // "12.5" % → 1250 bp: the same 2-decimal parse
    } catch {
      discountLimitBp = -1;
    }
    if (discountLimitBp < 0 || discountLimitBp > 10000) {
      throw new UserError("Enter a percentage from 0 to 100, up to 2 decimals.", "discountLimit");
    }
  }

  const values = {
    companyName: text(input.companyName, "companyName"),
    address: text(input.address, "address", 1000),
    gstin,
    stateCode,
    phone: text(input.phone, "phone"),
    email,
    bankDetails: text(input.bankDetails, "bankDetails", 1000),
    upiId,
    invoiceTerms: text(input.invoiceTerms, "invoiceTerms", 4000),
    discountLimitBp,
    backdateDays: days(input.backdateDays, "backdateDays"),
    defaultCreditDays: days(input.defaultCreditDays, "defaultCreditDays"),
  };
  await writeTx(actor, (tx) => tx.update(settings).set(values).where(eq(settings.id, 1)));
}

/** Logo or signature: an image already attached to settings, or null to clear it. */
export async function setSettingsImage(actor: SessionUser, image: "logo" | "signature", attachmentId: number | null) {
  if (!can(actor, "settings", "edit")) throw new Error("Not allowed");
  await writeTx(actor, async (tx) => {
    if (attachmentId !== null) {
      const [file] = await tx
        .select({ mime: attachments.mime })
        .from(attachments)
        .where(and(eq(attachments.id, attachmentId), eq(attachments.entityType, "settings")));
      if (!file?.mime.startsWith("image/")) throw new UserError("Pick an image uploaded to settings.");
    }
    const column = image === "logo" ? { logoAttachmentId: attachmentId } : { signatureAttachmentId: attachmentId };
    await tx.update(settings).set(column).where(eq(settings.id, 1));
  });
}

export type BooksInput = {
  booksStartDate: string; // DD/MM/YYYY, or blank
  accounts: { id: number; name: string; opening: string }[]; // money accounts; opening in rupees, minus = Cr
};

/** Blank = 0. */
function amount(value: string, field: string): bigint {
  if (!value.trim()) return 0n;
  try {
    return parseMoney(value);
  } catch {
    throw new UserError("Enter an amount like 1,00,000.50 (minus for an overdraft).", field);
  }
}

/**
 * The Books tab (D40): books start date + money accounts' names and opening balances, in one transaction.
 * A changed opening is reversed and posted again; a new start date moves every opening balance onto it.
 */
export async function saveBooks(actor: SessionUser, input: BooksInput): Promise<void> {
  if (!can(actor, "settings", "edit")) throw new Error("Not allowed");
  let date: string | null = null;
  if (input.booksStartDate.trim()) {
    try {
      date = parseDate(input.booksStartDate);
    } catch {
      throw new UserError("Use DD/MM/YYYY, e.g. 01/04/2026.", "booksStartDate");
    }
  }

  await writeTx(actor, async (tx) => {
    const [s] = await tx.select({ date: settings.booksStartDate }).from(settings).where(eq(settings.id, 1)).for("update");
    if (date !== s.date) {
      if (!date && (await liveOpenings(tx)).length) {
        throw new UserError("Opening balances are posted on this date, so it can't be blank.", "booksStartDate");
      }
      await tx.update(settings).set({ booksStartDate: date }).where(eq(settings.id, 1));
      if (date) await moveOpenings(tx, date);
    }

    const money = await tx.select().from(accounts).where(eq(accounts.isMoney, true)).for("update");
    for (const row of input.accounts) {
      const account = money.find((a) => a.id === row.id);
      if (!account) throw new Error("Not a money account");
      const name = text(row.name, `name.${row.id}`, 60);
      if (!name) throw new UserError("Give the account a name.", `name.${row.id}`);
      const opening = amount(row.opening, `opening.${row.id}`);
      if (name === account.name && opening === account.openingBalancePaise) continue;
      await tx.update(accounts).set({ name, openingBalancePaise: opening }).where(eq(accounts.id, account.id));
      if (opening !== account.openingBalancePaise) {
        const doc = { type: "accounts" as const, id: account.id, narration: `Opening balance: ${name}` };
        await setOpening(tx, doc, opening, { account: account.id }, { account: "opening_equity" });
      }
    }
  });
}
