import { eq, sql } from "drizzle-orm";
import { Workbook, type CellValue, type Worksheet } from "exceljs";
import { writeTx, type Tx } from "@/db";
import { accounts, customers, expenseCategories, openingBills, settings, stockItems, vendors } from "@/db/schema";
import { UserError } from "@/lib/action";
import { openingBillLabel, paidTowardsOpeningBills } from "@/lib/allocations";
import { insertCustomer, setCustomerOpening } from "@/lib/customers";
import { addDays, formatDate, parseDate } from "@/lib/dates";
import { GST_STATES } from "@/lib/gstin";
import { divRound, formatMoney, moneyText, parseMoney, parseQty } from "@/lib/num";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import { setMoneyOpening } from "@/lib/settings";
import { insertItem } from "@/lib/stock";
import { paidTowardsBills } from "@/lib/vendor-payments";
import { insertVendor, setVendorOpening } from "@/lib/vendors";

// Opening data import (T43, D40, D67; Q5 still open, so it takes both lump sums and bill-wise dues). The owner fills
// one Excel template — customers, customer opening bills, vendors, vendor opening bills, stock items, money accounts —
// and uploads it: the file is checked row by row (and against what is already in the CRM) and nothing is saved; then
// Import runs the same thing in one transaction, all or nothing. Rows go through the app's own services (the GSTIN,
// mobile, category and opening-balance rules are theirs); a party's opening balance = Σ its opening bills + its
// lump, posted once through setOpening. The uploaded file is untrusted: size and shape are checked, only values are
// read (a formula is refused, never evaluated), and amounts are read as text (hard rule 1).

type Column = { key: string; header: string; help: string; required?: true; field?: string };
type SheetDef = { name: string; about: string; columns: Column[] };

const AMOUNT = "Rupees as text, up to 2 decimals: 12500 or 12,500.50.";

export const SHEETS = {
  customers: {
    name: "Customers",
    about:
      "One row per customer. A customer already in the CRM (same mobile or GSTIN; the name for one with neither) is refused, unless it has no opening balance yet and the row brings one (a lump or bills): then only those dues are added and its other columns are ignored. Import before daily use.",
    columns: [
      { key: "name", header: "Name", required: true, field: "name", help: "The customer's name." },
      { key: "firmName", header: "Firm name", field: "firmName", help: "Optional." },
      { key: "mobile", header: "Mobile", field: "mobile", help: "Mobile number. The mobile or GSTIN is how the import spots customers already in the CRM; with neither, the exact name is." },
      { key: "gstin", header: "GSTIN", field: "gstin", help: "15 characters, e.g. 24ABCDE1234F1Z5. Its first two digits must be the state." },
      { key: "state", header: "State", field: "stateCode", help: "State code (24) or name (Gujarat). Blank = the GSTIN's state, or 24 Gujarat without a GSTIN." },
      { key: "email", header: "Email", field: "email", help: "Optional: where quotation and invoice PDFs are emailed." },
      { key: "billingAddress", header: "Billing address", field: "billingAddress", help: "Optional." },
      { key: "siteAddress", header: "Site address", field: "siteAddress", help: "Optional: delivery / site address." },
      { key: "creditLimit", header: "Credit limit", field: "creditLimit", help: `Optional. ${AMOUNT} Blank = no limit.` },
      { key: "creditDays", header: "Credit days", field: "creditDays", help: "Optional whole days. Blank = the default credit days in Settings." },
      { key: "creditCustomer", header: "Credit customer", help: "Yes or No (blank = No)." },
      {
        key: "lump",
        header: "Opening balance not bill-wise",
        field: "openingBalance",
        help: `What the customer owed on the books start date that is NOT listed bill by bill on "Customer opening bills". Minus = they had money with us (an advance). Blank = 0. ${AMOUNT}`,
      },
    ],
  },
  customerBills: {
    name: "Customer opening bills",
    about: "Unpaid old bills, one row each. Receipts can later be allocated to them, and outstanding ages them by their bill date.",
    columns: [
      {
        key: "party",
        header: "Customer mobile, GSTIN or name",
        required: true,
        help: 'The customer\'s mobile or GSTIN (the name, for one with neither) as on the "Customers" sheet, or of a customer already in the CRM with no opening balance yet.',
      },
      { key: "billNo", header: "Bill no", required: true, help: "The old bill's number. Each customer's bill numbers must differ." },
      { key: "billDate", header: "Bill date", required: true, help: "DD/MM/YYYY, on or before the books start date." },
      { key: "dueDate", header: "Due date", help: "DD/MM/YYYY, on or after the bill date. Blank = bill date + the customer's credit days." },
      { key: "amount", header: "Amount due", required: true, help: `What is still unpaid on this bill, more than 0. ${AMOUNT}` },
    ],
  },
  vendors: {
    name: "Vendors",
    about:
      "One row per vendor. A vendor already in the CRM (same GSTIN or name) is refused, unless it has no opening balance yet and the row brings one (a lump or bills): then only those dues are added and its other columns are ignored.",
    columns: [
      { key: "name", header: "Name", required: true, field: "name", help: "The vendor's name (it must differ from every other vendor's)." },
      { key: "gstin", header: "GSTIN", field: "gstin", help: "Optional, 15 characters. Its first two digits must be the state." },
      { key: "state", header: "State", field: "stateCode", help: "State code (24) or name (Gujarat). Blank = the GSTIN's state, or 24 Gujarat without a GSTIN." },
      { key: "mobile", header: "Mobile", field: "mobile", help: "Optional." },
      { key: "address", header: "Address", field: "address", help: "Optional." },
      { key: "creditDays", header: "Credit days", field: "creditDays", help: "Optional whole days." },
      {
        key: "lump",
        header: "Opening balance not bill-wise",
        field: "openingBalance",
        help: `What we owed the vendor on the books start date that is NOT listed bill by bill on "Vendor opening bills". Minus = they owed us (an advance we paid). Blank = 0. ${AMOUNT}`,
      },
    ],
  },
  vendorBills: {
    name: "Vendor opening bills",
    about: "The vendor's unpaid old bills, one row each. Vendor payments can later be allocated to them; pending payment ages them by their bill date.",
    columns: [
      { key: "party", header: "Vendor name or GSTIN", required: true, help: 'The vendor\'s name or GSTIN as on the "Vendors" sheet, or of a vendor already in the CRM with no opening balance yet.' },
      { key: "billNo", header: "Bill no", required: true, help: "The vendor's bill number. Each vendor's bill numbers must differ." },
      { key: "billDate", header: "Bill date", required: true, help: "DD/MM/YYYY, on or before the books start date." },
      { key: "dueDate", header: "Due date", help: "DD/MM/YYYY, on or after the bill date. Blank = bill date + the vendor's credit days." },
      { key: "amount", header: "Amount due", required: true, help: `What we still owe on this bill, more than 0. ${AMOUNT}` },
    ],
  },
  items: {
    name: "Stock items",
    about: "One row per stock item, with the stock in hand on the books start date. Items already in the CRM (same name) are refused.",
    columns: [
      { key: "name", header: "Name", required: true, field: "name", help: "The item's name, e.g. Acrylic sheet 3 mm." },
      { key: "unit", header: "Unit", field: "unit", help: "Optional: Nos, Sheet, Sq Ft, Kg… Blank = Nos. Purchases are entered in this unit." },
      { key: "category", header: "Category", required: true, field: "categoryId", help: "One of the expense categories in the CRM, e.g. Acrylic, ACP, LED Module, Flex, Vinyl, Ink." },
      { key: "hsn", header: "HSN", field: "hsnSac", help: "Optional, 4 to 8 digits." },
      { key: "gst", header: "GST %", field: "gstPercent", help: "Optional, e.g. 18 or 12.5." },
      { key: "openingQty", header: "Opening qty", field: "openingQty", help: "Stock in hand on the books start date, up to 3 decimals. Blank = 0." },
      { key: "openingRate", header: "Opening rate", field: "openingRate", help: `Value of one unit of that stock. ${AMOUNT} Blank = 0.` },
    ],
  },
  money: {
    name: "Money accounts",
    about: "Cash and bank balances on the books start date. Only accounts that already exist (Settings → Books) and have no opening balance yet.",
    columns: [
      { key: "account", header: "Account", required: true, help: "The account's name as in Settings → Books, e.g. Cash, Petty Cash, UPI, Bank 1." },
      { key: "opening", header: "Opening balance", required: true, help: `Balance on the books start date; minus = overdrawn. ${AMOUNT}` },
    ],
  },
} satisfies Record<string, SheetDef>;

type SheetKey = keyof typeof SHEETS;
const KEYS = Object.keys(SHEETS) as SheetKey[];

const README = "Read me";

/**
 * The template (rows = none) or a filled workbook (the T43 test's sample): a "Read me" sheet explaining every column,
 * then one sheet per kind with its header row. Every cell is Text, so Excel keeps amounts, mobiles and dates as typed.
 */
export async function openingWorkbook(rows: Partial<Record<SheetKey, string[][]>> = {}): Promise<Buffer> {
  const book = new Workbook();
  book.creator = "Radhe CRM";
  const readme = book.addWorksheet(README);
  readme.columns = [{ width: 26 }, { width: 32 }, { width: 100 }];
  readme.addRow(["Radhe CRM — opening data"]).font = { bold: true, size: 14 };
  for (const line of [
    "Fill the sheets below with what you had on the books start date (Settings → Books — set it first), then upload this file in Settings → Data → Import opening data.",
    "The upload is checked first and nothing is saved: fix every row it lists, upload again, then press Import. Import saves everything or nothing.",
    "Leave a sheet empty if it doesn't apply. Don't rename sheets or columns. Type values (no formulas). Dates as DD/MM/YYYY.",
    "A customer's or vendor's opening balance = the sum of its opening bills + its 'Opening balance not bill-wise'.",
  ]) {
    readme.addRow([line]);
  }
  readme.addRow([]);
  readme.addRow(["Sheet", "Column", "What to type"]).font = { bold: true };
  for (const key of KEYS) {
    const def = SHEETS[key];
    readme.addRow([def.name, "", def.about]).font = { bold: true };
    for (const c of def.columns) readme.addRow(["", `${c.header}${"required" in c ? " *" : ""}`, c.help]);
  }
  readme.getColumn(3).alignment = { wrapText: true, vertical: "top" };

  for (const key of KEYS) {
    const def = SHEETS[key];
    const sheet = book.addWorksheet(def.name);
    sheet.columns = def.columns.map((c) => ({ header: c.header, key: c.key, width: Math.max(14, c.header.length + 4), style: { numFmt: "@" } }));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    for (const r of rows[key] ?? []) sheet.addRow(r);
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

// ---- Reading the upload

export const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 10_000;

/** One thing wrong: a sheet / row / column (row = the Excel row number) or the file as a whole. */
export type Problem = { sheet: string | null; row: number | null; column: string | null; message: string };
type Line = { row: number; v: Record<string, string> };

/** A cell's value as text, never as a computed number; a formula or an error cell is refused. */
function cellText(value: CellValue): { text: string } | { error: string } {
  if (value === null || value === undefined) return { text: "" };
  if (typeof value === "string") return { text: value.trim() };
  // A number cell is read back as its shortest decimal text (what was typed), then parsed like typed text.
  if (typeof value === "number") return { text: String(value) };
  if (typeof value === "boolean") return { text: value ? "Yes" : "No" };
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return { text: `${pad(value.getUTCDate())}/${pad(value.getUTCMonth() + 1)}/${value.getUTCFullYear()}` };
  }
  if ("formula" in value || "sharedFormula" in value) return { error: "Holds a formula: type the value instead." };
  if ("error" in value) return { error: `Holds an Excel error (${value.error}).` };
  if ("richText" in value) return { text: value.richText.map((t) => t.text).join("").trim() };
  if ("text" in value) return { text: String(value.text).trim() };
  return { error: "Can't be read: type plain text." };
}

function readSheet(sheet: Worksheet | undefined, def: SheetDef, problems: Problem[]): Line[] {
  if (!sheet) {
    problems.push({ sheet: def.name, row: null, column: null, message: `The "${def.name}" sheet is missing: use the template.` });
    return [];
  }
  const header = def.columns.map((_, i) => cellText(sheet.getRow(1).getCell(i + 1).value));
  const extra = cellText(sheet.getRow(1).getCell(def.columns.length + 1).value);
  if (header.some((h, i) => !("text" in h) || h.text !== def.columns[i].header) || !("text" in extra) || extra.text) {
    problems.push({ sheet: def.name, row: 1, column: null, message: `The columns must be exactly: ${def.columns.map((c) => c.header).join(", ")}. Use the template.` });
    return [];
  }
  if (sheet.rowCount > MAX_ROWS + 1) {
    problems.push({ sheet: def.name, row: null, column: null, message: `More than ${MAX_ROWS.toLocaleString("en-IN")} rows: split the file.` });
    return [];
  }
  const lines: Line[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const v: Record<string, string> = {};
    let bad = false;
    def.columns.forEach((c, i) => {
      const t = cellText(row.getCell(i + 1).value);
      if ("error" in t) {
        problems.push({ sheet: def.name, row: r, column: c.header, message: t.error });
        bad = true;
      } else v[c.key] = t.text;
    });
    const beyond = cellText(row.getCell(def.columns.length + 1).value);
    if (!("text" in beyond) || beyond.text) {
      problems.push({ sheet: def.name, row: r, column: null, message: "Has a value right of the last column." });
      bad = true;
    }
    if (!bad && Object.values(v).every((x) => !x)) continue; // blank row
    if (!bad) lines.push({ row: r, v });
  }
  return lines;
}

// ---- Checking and importing

export type SheetTotal = { sheet: string; rows: number; amount: string | null };
export type ImportResult = { imported: boolean; problems: Problem[]; duplicates: Problem[]; totals: SheetTotal[] };

class Rollback extends Error {
  constructor(readonly result: ImportResult) {
    super("rollback");
  }
}

const lower = (s: string) => s.trim().toLowerCase();
const last10 = (mobile: string) => mobile.replace(/\D/g, "").slice(-10);
const gstinKey = (gstin: string) => gstin.replace(/\s/g, "").toUpperCase();
const looksLikeGstin = (text: string) => gstinKey(text).length === 15 && /^\d\d/.test(gstinKey(text));
/** D68: a customer with neither mobile nor GSTIN is keyed by its exact name (trimmed, case-insensitive). */
const nameKey = (name: string) => `name:${lower(name)}`;

/**
 * Checks the uploaded workbook and, with `commit`, imports it — one transaction either way, rolled back unless
 * `commit` and nothing is wrong. Owner only (Settings), with can_view_cost (opening stock is valued).
 */
export async function importOpeningData(actor: SessionUser, file: Uint8Array, commit: boolean): Promise<ImportResult> {
  if (!can(actor, "settings", "edit")) throw new Error("Not allowed");
  if (!canViewCost(actor)) throw new UserError('Opening stock is valued: turn on "Can see cost, profit and purchase rates" for your user first.');
  if (file.byteLength > MAX_BYTES) throw new UserError("The file is over 2 MB: split it, or remove pictures and other sheets.");
  // An .xlsx is a zip; anything else (an old .xls, a CSV, a renamed file) is refused before parsing.
  if (file.byteLength < 4 || file[0] !== 0x50 || file[1] !== 0x4b || file[2] !== 0x03 || file[3] !== 0x04) {
    throw new UserError("That isn't an Excel .xlsx file: download the template and fill it in.");
  }
  const book = new Workbook();
  try {
    // ponytail: exceljs inflates the whole zip in memory; the 2 MB / 10,000-row caps and owner-only access bound it.
    await book.xlsx.load(Buffer.from(file) as unknown as Parameters<typeof book.xlsx.load>[0]); // typed for an older Buffer
  } catch {
    throw new UserError("The file couldn't be read as an Excel workbook: save it again as .xlsx from Excel.");
  }
  const problems: Problem[] = [];
  const lines = Object.fromEntries(KEYS.map((k) => [k, readSheet(book.getWorksheet(SHEETS[k].name), SHEETS[k], problems)])) as Record<SheetKey, Line[]>;
  if (problems.length) return { imported: false, problems, duplicates: [], totals: [] };

  try {
    return await writeTx(actor, async (tx) => {
      const result = await run(tx, actor, lines);
      if (!commit || result.problems.length || result.duplicates.length) throw new Rollback(result);
      return { ...result, imported: true };
    });
  } catch (e) {
    if (e instanceof Rollback) return e.result;
    throw e;
  }
}

async function run(tx: Tx, actor: SessionUser, lines: Record<SheetKey, Line[]>): Promise<ImportResult> {
  // One import at a time: two at once could both pass the duplicate check.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('opening-import'))`);
  const problems: Problem[] = [];
  const duplicates: Problem[] = [];
  const [s] = await tx.select().from(settings).where(eq(settings.id, 1));
  const start = s.booksStartDate;
  if (!start) {
    problems.push({ sheet: null, row: null, column: null, message: "Set the books start date first (Settings → Books): openings are posted on it." });
    return { imported: false, problems, duplicates, totals: [] };
  }
  const say = (key: SheetKey, row: number | null, column: string | null, message: string) => problems.push({ sheet: SHEETS[key].name, row, column, message });
  const dup = (key: SheetKey, row: number, column: string | null, message: string) => duplicates.push({ sheet: SHEETS[key].name, row, column, message });
  const header = (key: SheetKey, k: string) => SHEETS[key].columns.find((c) => c.key === k)!.header;

  /** Each line's required columns, or a problem per missing one. */
  const complete = (key: SheetKey, l: Line) => {
    const missing = SHEETS[key].columns.filter((c) => "required" in c && !l.v[c.key]);
    for (const c of missing) say(key, l.row, c.header, "Required.");
    return missing.length === 0;
  };
  /** Rupees as text, up to 2 decimals (hard rule 1), or null after a problem. */
  const money = (key: SheetKey, l: Line, k: string, positive = false): bigint | null => {
    const text = l.v[k].replace(/^₹\s*/, "");
    if (!text) return 0n;
    try {
      const v = parseMoney(text);
      if (!positive || v > 0n) return v;
      say(key, l.row, header(key, k), "Must be more than 0.");
    } catch {
      say(key, l.row, header(key, k), `"${l.v[k]}" isn't an amount: type it like 12500 or 12,500.50 (up to 2 decimals).`);
    }
    return null;
  };
  const date = (key: SheetKey, l: Line, k: string): string | null => {
    try {
      return parseDate(l.v[k]);
    } catch {
      say(key, l.row, header(key, k), `"${l.v[k]}" isn't a date: type it as DD/MM/YYYY.`);
      return null;
    }
  };
  /** State code or name → code; blank = the GSTIN's state, else 24. */
  const state = (key: SheetKey, l: Line): string | null => {
    const typed = l.v.state;
    if (!typed) return gstinKey(l.v.gstin ?? "").slice(0, 2).match(/^\d\d$/) ? gstinKey(l.v.gstin).slice(0, 2) : "24";
    const found = GST_STATES.find(([code, name]) => code === typed.padStart(2, "0") || lower(name) === lower(typed));
    if (!found) say(key, l.row, header(key, "state"), `Unknown state "${typed}": type its 2-digit code (24) or its name.`);
    return found?.[0] ?? null;
  };
  /** Runs one row's service call in a savepoint: its UserError becomes a problem and the import goes on to list more. */
  async function attempt<T>(key: SheetKey, l: Line, fn: (sp: Tx) => Promise<T>): Promise<T | null> {
    try {
      return await tx.transaction(fn);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      const column = SHEETS[key].columns.find((c) => "field" in c && c.field === e.field);
      say(key, l.row, column?.header ?? null, e.message);
      return null;
    }
  }
  /** Bills of one kind, checked: party key → its good bills; `parties` = every row's party (to check they exist). */
  type Bill = { line: Line; billNo: string; billDate: string; dueDate: string | null; amount: bigint };
  const readBills = (key: "customerBills" | "vendorBills", partyKey: (party: string) => string) => {
    const byParty = new Map<string, Bill[]>();
    const parties: { key: string; row: number }[] = [];
    const seen = new Map<string, number>();
    for (const l of lines[key]) {
      if (!complete(key, l)) continue;
      parties.push({ key: partyKey(l.v.party), row: l.row });
      const billDate = date(key, l, "billDate");
      const dueDate = l.v.dueDate ? date(key, l, "dueDate") : null;
      const amount = money(key, l, "amount", true);
      if (billDate && billDate > start) say(key, l.row, header(key, "billDate"), `After the books start date (${formatDate(start)}): an opening bill is dated on or before it.`);
      if (billDate && dueDate && dueDate < billDate) say(key, l.row, header(key, "dueDate"), "Before the bill date.");
      const k = `${partyKey(l.v.party)}|${lower(l.v.billNo)}`;
      if (seen.has(k)) say(key, l.row, header(key, "billNo"), `Same bill no as row ${seen.get(k)} for this party.`);
      seen.set(k, l.row);
      if (!billDate || amount === null || (l.v.dueDate && !dueDate)) continue;
      const list = byParty.get(partyKey(l.v.party)) ?? [];
      list.push({ line: l, billNo: l.v.billNo.trim(), billDate, dueDate, amount });
      byParty.set(partyKey(l.v.party), list);
    }
    return { byParty, parties };
  };
  // Opening bills already in the CRM: their numbers stay taken (cancelled too); a live one means an opening is posted.
  const billRows = await tx.select({ c: openingBills.customerId, v: openingBills.vendorId, no: openingBills.billNo, cancelledAt: openingBills.cancelledAt }).from(openingBills);
  const partyOf = (b: { c: number | null; v: number | null }) => (b.c !== null ? `c${b.c}` : `v${b.v}`);
  const existingBills = new Set(billRows.map((b) => `${partyOf(b)}|${lower(b.no)}`));
  const withBills = new Set(billRows.filter((b) => !b.cancelledAt).map(partyOf));

  /**
   * D68: dues (bills and / or a lump) for a party already in the CRM — allowed while it has no opening posted, so
   * masters may come first and dues later. The party row is locked; its opening = Σ bills + lump, posted once.
   */
  async function duesForExisting(side: "c" | "v", found: { id: number; name: string }, mine: Bill[], lump: bigint, sheet: SheetKey, line: Line) {
    const billSheet = side === "c" ? "customerBills" : "vendorBills";
    const [current] =
      side === "c"
        ? await tx.select({ opening: customers.openingBalancePaise, days: customers.creditDays }).from(customers).where(eq(customers.id, found.id)).for("update")
        : await tx.select({ opening: vendors.openingBalancePaise, days: vendors.creditDays }).from(vendors).where(eq(vendors.id, found.id)).for("update");
    const hasOpening = current.opening !== 0n || withBills.has(`${side}${found.id}`);
    if (hasOpening && sheet !== billSheet) dup(sheet, line.row, null, `Already in the CRM with an opening balance: ${found.name}.`);
    let refused = hasOpening;
    for (const b of mine) {
      if (existingBills.has(`${side}${found.id}|${lower(b.billNo)}`)) dup(billSheet, b.line.row, header(billSheet, "billNo"), `Already in the CRM: ${found.name}'s bill ${b.billNo}.`);
      else if (hasOpening && sheet === billSheet) dup(billSheet, b.line.row, header(billSheet, "party"), `${found.name} already has an opening balance in the CRM: change it on their page.`);
      else continue;
      refused = true;
    }
    if (refused) return;
    const sum = mine.reduce((t, b) => t + b.amount, lump);
    await attempt(sheet, line, async (sp) => {
      await insertBills(sp, side === "c" ? { customerId: found.id } : { vendorId: found.id }, mine, current.days ?? (side === "c" ? s.defaultCreditDays : null));
      await (side === "c" ? setCustomerOpening : setVendorOpening)(sp, found.id, found.name, sum);
    });
  }
  /** A party's opening bills; a blank due date = bill date + its credit days. */
  async function insertBills(q: Tx, party: { customerId: number } | { vendorId: number }, mine: Bill[], days: number | null) {
    if (!mine.length) return;
    await q.insert(openingBills).values(
      mine.map((b) => ({ ...party, billNo: b.billNo, billDate: b.billDate, dueDate: b.dueDate ?? addDays(b.billDate, days ?? 0), amountPaise: b.amount, createdBy: actor.id })),
    );
  }
  /** Bill rows naming a party that isn't on its master sheet → that party in the CRM (D68), grouped by party. */
  function billsForCrm<P extends { id: number; name: string }>(
    billSheet: "customerBills" | "vendorBills",
    parties: { key: string; row: number }[],
    bills: Map<string, Bill[]>,
    onSheet: Map<string, number>,
    inCrm: (key: string) => P[],
    what: "customer" | "vendor",
  ) {
    const out = new Map<number, { party: P; bills: Bill[] }>();
    const done = new Set<string>();
    for (const p of parties) {
      if (onSheet.has(p.key)) continue;
      const matches = inCrm(p.key);
      if (!matches.length) {
        say(billSheet, p.row, header(billSheet, "party"), `No ${what} with this ${what === "customer" ? "mobile, GSTIN or name" : "name or GSTIN"} on the sheet or in the CRM.`);
        continue;
      }
      if (matches.length > 1) {
        say(billSheet, p.row, header(billSheet, "party"), `More than one ${what} in the CRM matches (${matches.map((m) => m.name).join(", ")}): use the ${what === "customer" ? "mobile or GSTIN" : "GSTIN"}.`);
        continue;
      }
      if (done.has(p.key)) continue;
      done.add(p.key);
      const entry = out.get(matches[0].id) ?? { party: matches[0], bills: [] };
      entry.bills.push(...(bills.get(p.key) ?? []));
      out.set(matches[0].id, entry);
    }
    return out;
  }
  const totals: SheetTotal[] = [];
  const total = (key: SheetKey, rows: number, amount: bigint | null) => totals.push({ sheet: SHEETS[key].name, rows, amount: amount === null ? null : formatMoney(amount) });

  // ---- Customers and their opening bills
  {
    const inDb = await tx.select({ id: customers.id, name: customers.name, mobile: customers.mobile, gstin: customers.gstin }).from(customers);
    const keyOf = new Map<string, number>(); // file key (GSTIN / last 10 mobile digits / name) → row
    const customerKey = (p: string) => (looksLikeGstin(p) ? gstinKey(p) : /^[\d\s+()-]+$/.test(p.trim()) ? last10(p) : nameKey(p));
    const inCrm = (key: string) =>
      inDb.filter((c) => (key.startsWith("name:") ? nameKey(c.name) === key : c.gstin === key || (!!c.mobile && last10(c.mobile) === key)));
    const { byParty: bills, parties } = readBills("customerBills", customerKey);
    const handled = new Set<number>(); // CRM customers whose dues came from a "Customers" row
    let lumps = 0n;
    for (const l of lines.customers) {
      if (!complete("customers", l)) continue;
      const stateCode = state("customers", l);
      const lump = money("customers", l, "lump");
      const creditCustomer = lower(l.v.creditCustomer);
      if (creditCustomer && creditCustomer !== "yes" && creditCustomer !== "no") say("customers", l.row, header("customers", "creditCustomer"), "Type Yes or No.");
      const keys = [l.v.gstin && gstinKey(l.v.gstin), l.v.mobile && last10(l.v.mobile)].filter((k): k is string => !!k);
      if (!keys.length) keys.push(nameKey(l.v.name)); // D68
      const twin = keys.map((k) => keyOf.get(k)).find((r) => r !== undefined);
      if (twin !== undefined) {
        say("customers", l.row, null, `Same mobile, GSTIN or name as row ${twin}.`);
        continue;
      }
      for (const k of keys) keyOf.set(k, l.row);
      const found = [...new Map(keys.flatMap(inCrm).map((c) => [c.id, c])).values()];
      const mine = keys.flatMap((k) => bills.get(k) ?? []);
      if (found.length) {
        if (lump === null) continue;
        if (lump === 0n && !mine.length) dup("customers", l.row, null, `Already in the CRM: ${found[0].name}.`);
        else if (found.length > 1) say("customers", l.row, null, `Matches more than one customer in the CRM (${found.map((c) => c.name).join(", ")}): give the mobile or GSTIN.`);
        else {
          handled.add(found[0].id);
          lumps += lump;
          await duesForExisting("c", found[0], mine, lump, "customers", l);
        }
        continue;
      }
      if (stateCode === null || lump === null) continue;
      lumps += lump;
      const sum = mine.reduce((t, b) => t + b.amount, lump); // the party's opening balance (D67)
      const id = await attempt("customers", l, (sp) =>
        insertCustomer(
          sp,
          actor,
          {
            name: l.v.name, firmName: l.v.firmName, mobile: l.v.mobile, email: l.v.email, gstin: l.v.gstin, stateCode, billingAddress: l.v.billingAddress,
            siteAddress: l.v.siteAddress, creditLimit: l.v.creditLimit.replace(/^₹\s*/, ""), creditDays: l.v.creditDays, isCreditCustomer: creditCustomer === "yes",
            salesPersonId: "", collectionPersonId: "", notes: "", openingBalance: moneyText(sum),
          },
          s.defaultCreditDays,
        ),
      );
      if (id !== null) await insertBills(tx, { customerId: id }, mine, l.v.creditDays ? Number(l.v.creditDays) : s.defaultCreditDays);
    }
    for (const [id, e] of billsForCrm("customerBills", parties, bills, keyOf, inCrm, "customer")) {
      if (!e.bills.length) continue; // its rows had problems of their own
      if (handled.has(id)) say("customerBills", e.bills[0].line.row, header("customerBills", "party"), `${e.party.name} is on the "Customers" sheet: use the same mobile, GSTIN or name as there.`);
      else await duesForExisting("c", e.party, e.bills, 0n, "customerBills", e.bills[0].line);
    }
    total("customers", lines.customers.length, lumps);
    total("customerBills", lines.customerBills.length, [...bills.values()].flat().reduce((t, b) => t + b.amount, 0n));
  }

  // ---- Vendors and their opening bills
  {
    const inDb = await tx.select({ id: vendors.id, name: vendors.name, gstin: vendors.gstin }).from(vendors);
    const keyOf = new Map<string, number>();
    const vendorKey = (p: string) => (looksLikeGstin(p) ? gstinKey(p) : lower(p));
    const inCrm = (key: string) => inDb.filter((v) => lower(v.name) === key || v.gstin === key);
    const { byParty: bills, parties } = readBills("vendorBills", vendorKey);
    const handled = new Set<number>();
    let lumps = 0n;
    for (const l of lines.vendors) {
      if (!complete("vendors", l)) continue;
      const stateCode = state("vendors", l);
      const lump = money("vendors", l, "lump");
      const keys = [lower(l.v.name), l.v.gstin && gstinKey(l.v.gstin)].filter((k): k is string => !!k);
      const twin = keys.map((k) => keyOf.get(k)).find((r) => r !== undefined);
      if (twin !== undefined) {
        say("vendors", l.row, null, `Same name or GSTIN as row ${twin}.`);
        continue;
      }
      for (const k of keys) keyOf.set(k, l.row);
      const found = [...new Map(keys.flatMap(inCrm).map((v) => [v.id, v])).values()];
      const mine = keys.flatMap((k) => bills.get(k) ?? []);
      if (found.length) {
        if (lump === null) continue;
        if (lump === 0n && !mine.length) dup("vendors", l.row, null, `Already in the CRM: ${found[0].name}.`);
        else if (found.length > 1) say("vendors", l.row, null, `Matches more than one vendor in the CRM (${found.map((v) => v.name).join(", ")}).`);
        else {
          handled.add(found[0].id);
          lumps += lump;
          await duesForExisting("v", found[0], mine, lump, "vendors", l);
        }
        continue;
      }
      if (stateCode === null || lump === null) continue;
      lumps += lump;
      const sum = mine.reduce((t, b) => t + b.amount, lump);
      const id = await attempt("vendors", l, (sp) =>
        insertVendor(sp, actor, {
          name: l.v.name, gstin: l.v.gstin, stateCode, mobile: l.v.mobile, address: l.v.address, creditDays: l.v.creditDays, notes: "", openingBalance: moneyText(sum),
        }),
      );
      if (id !== null) await insertBills(tx, { vendorId: id }, mine, l.v.creditDays ? Number(l.v.creditDays) : 0);
    }
    for (const [id, e] of billsForCrm("vendorBills", parties, bills, keyOf, inCrm, "vendor")) {
      if (!e.bills.length) continue;
      if (handled.has(id)) say("vendorBills", e.bills[0].line.row, header("vendorBills", "party"), `${e.party.name} is on the "Vendors" sheet: use the same name or GSTIN as there.`);
      else await duesForExisting("v", e.party, e.bills, 0n, "vendorBills", e.bills[0].line);
    }
    total("vendors", lines.vendors.length, lumps);
    total("vendorBills", lines.vendorBills.length, [...bills.values()].flat().reduce((t, b) => t + b.amount, 0n));
  }

  // ---- Stock items (opening qty × rate, D40, D52)
  {
    const [inDb, categories] = await Promise.all([
      tx.select({ name: stockItems.name }).from(stockItems),
      tx.select({ id: expenseCategories.id, name: expenseCategories.name }).from(expenseCategories).where(eq(expenseCategories.active, true)),
    ]);
    const seen = new Map<string, number>();
    let value = 0n;
    for (const l of lines.items) {
      if (!complete("items", l)) continue;
      const name = lower(l.v.name);
      if (seen.has(name)) {
        say("items", l.row, header("items", "name"), `Same name as row ${seen.get(name)}.`);
        continue;
      }
      seen.set(name, l.row);
      if (inDb.some((i) => lower(i.name) === name)) {
        dup("items", l.row, header("items", "name"), `Already in the CRM: ${l.v.name}.`);
        continue;
      }
      const category = categories.find((c) => lower(c.name) === lower(l.v.category));
      if (!category) say("items", l.row, header("items", "category"), `Unknown category "${l.v.category}": use one of ${categories.map((c) => c.name).join(", ")}.`);
      let qty: bigint | null = 0n;
      try {
        qty = l.v.openingQty ? parseQty(l.v.openingQty) : 0n;
        if (qty < 0n) throw new Error("negative");
      } catch {
        say("items", l.row, header("items", "openingQty"), `"${l.v.openingQty}" isn't a quantity: type it like 10 or 2.5 (not below 0).`);
        qty = null;
      }
      const rate = money("items", l, "openingRate");
      if (rate !== null && rate < 0n) say("items", l.row, header("items", "openingRate"), "Can't be below 0.");
      if (!category || qty === null || rate === null || rate < 0n) continue;
      value += divRound(qty * rate, 1000n);
      await attempt("items", l, (sp) =>
        insertItem(sp, actor, {
          name: l.v.name, unit: l.v.unit, categoryId: String(category.id), hsnSac: l.v.hsn, gstPercent: l.v.gst.replace(/%$/, ""),
          openingQty: l.v.openingQty, openingRate: l.v.openingRate.replace(/^₹\s*/, ""),
        }),
      );
    }
    total("items", lines.items.length, value);
  }

  // ---- Money accounts (existing ones, D40)
  {
    const moneyAccounts = await tx.select().from(accounts).where(eq(accounts.isMoney, true));
    const seen = new Map<number, number>();
    let sum = 0n;
    for (const l of lines.money) {
      if (!complete("money", l)) continue;
      const account = moneyAccounts.find((a) => lower(a.name) === lower(l.v.account));
      if (!account) {
        say("money", l.row, header("money", "account"), `No money account "${l.v.account}": use one of ${moneyAccounts.map((a) => a.name).join(", ")}.`);
        continue;
      }
      if (seen.has(account.id)) {
        say("money", l.row, header("money", "account"), `Same account as row ${seen.get(account.id)}.`);
        continue;
      }
      seen.set(account.id, l.row);
      if (account.openingBalancePaise !== 0n) {
        dup("money", l.row, header("money", "account"), `${account.name} already has an opening balance of ${formatMoney(account.openingBalancePaise)}.`);
        continue;
      }
      const opening = money("money", l, "opening");
      if (opening === null) continue;
      sum += opening;
      await attempt("money", l, (sp) => setMoneyOpening(sp, account, opening));
    }
    total("money", lines.money.length, sum);
  }

  return { imported: false, problems, duplicates, totals };
}

/**
 * D68: the owner cancels an opening bill nothing is allocated to (a wrong or doubled line). The row stays, marked
 * cancelled (audited); the party's opening balance is reversed and reposted without it (D40). Returns the party's page.
 */
export async function cancelOpeningBill(actor: SessionUser, id: number): Promise<string> {
  if (!can(actor, "settings", "edit")) throw new Error("Not allowed");
  return writeTx(actor, async (tx) => {
    const [bill] = await tx.select().from(openingBills).where(eq(openingBills.id, id)).for("update");
    if (!bill) throw new UserError("That opening bill doesn't exist.");
    const label = openingBillLabel(bill.billNo);
    if (bill.cancelledAt) throw new UserError(`${label} is already cancelled.`);
    const paid = (bill.customerId !== null ? await paidTowardsOpeningBills(tx, [id]) : await paidTowardsBills(tx, [id], undefined, "opening_bill")).get(id);
    if (paid) {
      const by = bill.customerId !== null ? "receipt or adjustment" : "payment";
      throw new UserError(`${label} has ${formatMoney(paid)} allocated to it: take that off first (edit the ${by}).`);
    }
    await tx.update(openingBills).set({ cancelledAt: new Date() }).where(eq(openingBills.id, id));
    if (bill.customerId !== null) {
      const [c] = await tx.select({ name: customers.name, opening: customers.openingBalancePaise }).from(customers).where(eq(customers.id, bill.customerId)).for("update");
      await setCustomerOpening(tx, bill.customerId, c.name, c.opening - bill.amountPaise);
      return `/customers/${bill.customerId}`;
    }
    const [v] = await tx.select({ name: vendors.name, opening: vendors.openingBalancePaise }).from(vendors).where(eq(vendors.id, bill.vendorId!)).for("update");
    await setVendorOpening(tx, bill.vendorId!, v.name, v.opening - bill.amountPaise);
    return `/vendors/${bill.vendorId}`;
  });
}
