import { eq, sql } from "drizzle-orm";
import { Workbook, type CellValue, type Worksheet } from "exceljs";
import { writeTx, type Tx } from "@/db";
import { accounts, customers, expenseCategories, openingBills, settings, stockItems, vendors } from "@/db/schema";
import { UserError } from "@/lib/action";
import { insertCustomer } from "@/lib/customers";
import { addDays, formatDate, parseDate } from "@/lib/dates";
import { GST_STATES } from "@/lib/gstin";
import { divRound, formatMoney, moneyText, parseMoney, parseQty } from "@/lib/num";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import { setMoneyOpening } from "@/lib/settings";
import { insertItem } from "@/lib/stock";
import { insertVendor } from "@/lib/vendors";

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
    about: "One row per customer. Customers already in the CRM (same mobile or GSTIN) are refused — import before entering customers by hand.",
    columns: [
      { key: "name", header: "Name", required: true, field: "name", help: "The customer's name." },
      { key: "firmName", header: "Firm name", field: "firmName", help: "Optional." },
      { key: "mobile", header: "Mobile", field: "mobile", help: "Mobile number. A mobile or a GSTIN is needed: they are how the import spots customers already in the CRM." },
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
      { key: "party", header: "Customer mobile or GSTIN", required: true, help: 'The customer\'s mobile or GSTIN exactly as on the "Customers" sheet.' },
      { key: "billNo", header: "Bill no", required: true, help: "The old bill's number. Each customer's bill numbers must differ." },
      { key: "billDate", header: "Bill date", required: true, help: "DD/MM/YYYY, on or before the books start date." },
      { key: "dueDate", header: "Due date", help: "DD/MM/YYYY, on or after the bill date. Blank = bill date + the customer's credit days." },
      { key: "amount", header: "Amount due", required: true, help: `What is still unpaid on this bill, more than 0. ${AMOUNT}` },
    ],
  },
  vendors: {
    name: "Vendors",
    about: "One row per vendor. Vendors already in the CRM (same GSTIN or name) are refused.",
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
      { key: "party", header: "Vendor name or GSTIN", required: true, help: 'The vendor\'s name or GSTIN exactly as on the "Vendors" sheet.' },
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
  const readBills = (key: "customerBills" | "vendorBills", partyKey: (party: string) => string) => {
    const byParty = new Map<string, { line: Line; billNo: string; billDate: string; dueDate: string | null; amount: bigint }[]>();
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
  const existingBills = new Set(
    (await tx.select({ c: openingBills.customerId, v: openingBills.vendorId, no: openingBills.billNo }).from(openingBills)).map((b) =>
      b.c !== null ? `c${b.c}|${lower(b.no)}` : `v${b.v}|${lower(b.no)}`,
    ),
  );
  const totals: SheetTotal[] = [];
  const total = (key: SheetKey, rows: number, amount: bigint | null) => totals.push({ sheet: SHEETS[key].name, rows, amount: amount === null ? null : formatMoney(amount) });

  // ---- Customers and their opening bills
  {
    const inDb = await tx.select({ id: customers.id, name: customers.name, mobile: customers.mobile, gstin: customers.gstin }).from(customers);
    const keyOf = new Map<string, number>(); // file key (GSTIN / last 10 mobile digits) → row
    const customerKey = (party: string) => (gstinKey(party).length === 15 ? gstinKey(party) : last10(party) || lower(party));
    const { byParty: bills, parties } = readBills("customerBills", customerKey);
    let lumps = 0n;
    for (const l of lines.customers) {
      if (!complete("customers", l)) continue;
      const stateCode = state("customers", l);
      const lump = money("customers", l, "lump");
      const creditCustomer = lower(l.v.creditCustomer);
      if (creditCustomer && creditCustomer !== "yes" && creditCustomer !== "no") say("customers", l.row, header("customers", "creditCustomer"), "Type Yes or No.");
      const keys = [l.v.gstin && gstinKey(l.v.gstin), l.v.mobile && last10(l.v.mobile)].filter((k): k is string => !!k);
      if (!keys.length) {
        say("customers", l.row, header("customers", "mobile"), "Give a mobile or a GSTIN: they are how duplicates are spotted.");
        continue;
      }
      const twin = keys.map((k) => keyOf.get(k)).find((r) => r !== undefined);
      if (twin !== undefined) {
        say("customers", l.row, null, `Same mobile or GSTIN as row ${twin}.`);
        continue;
      }
      for (const k of keys) keyOf.set(k, l.row);
      const found = inDb.find((c) => (c.gstin && keys.includes(c.gstin)) || (c.mobile && keys.includes(last10(c.mobile))));
      const mine = keys.flatMap((k) => bills.get(k) ?? []);
      if (found) {
        dup("customers", l.row, null, `Already in the CRM: ${found.name}.`);
        for (const b of mine) if (existingBills.has(`c${found.id}|${lower(b.billNo)}`)) dup("customerBills", b.line.row, null, `Already in the CRM: ${found.name}'s bill ${b.billNo}.`);
        continue;
      }
      if (stateCode === null || lump === null) continue;
      lumps += lump;
      const sum = mine.reduce((s, b) => s + b.amount, lump); // the party's opening balance (D67)
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
      if (id === null) continue;
      const days = l.v.creditDays ? Number(l.v.creditDays) : s.defaultCreditDays;
      for (const b of mine) {
        await tx.insert(openingBills).values({
          customerId: id, billNo: b.billNo, billDate: b.billDate, dueDate: b.dueDate ?? addDays(b.billDate, days ?? 0), amountPaise: b.amount, createdBy: actor.id,
        });
      }
    }
    for (const p of parties) {
      if (!keyOf.has(p.key)) say("customerBills", p.row, header("customerBills", "party"), `No customer with this mobile or GSTIN on the "Customers" sheet.`);
    }
    total("customers", lines.customers.length, lumps);
    total("customerBills", lines.customerBills.length, [...bills.values()].flat().reduce((t, b) => t + b.amount, 0n));
  }

  // ---- Vendors and their opening bills
  {
    const inDb = await tx.select({ id: vendors.id, name: vendors.name, gstin: vendors.gstin }).from(vendors);
    const keyOf = new Map<string, number>();
    const vendorKey = (party: string) => (gstinKey(party).length === 15 && /^\d\d/.test(party.trim()) ? gstinKey(party) : lower(party));
    const { byParty: bills, parties } = readBills("vendorBills", vendorKey);
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
      const found = inDb.find((v) => lower(v.name) === lower(l.v.name) || (v.gstin && keys.includes(v.gstin)));
      const mine = keys.flatMap((k) => bills.get(k) ?? []);
      if (found) {
        dup("vendors", l.row, null, `Already in the CRM: ${found.name}.`);
        for (const b of mine) if (existingBills.has(`v${found.id}|${lower(b.billNo)}`)) dup("vendorBills", b.line.row, null, `Already in the CRM: ${found.name}'s bill ${b.billNo}.`);
        continue;
      }
      if (stateCode === null || lump === null) continue;
      lumps += lump;
      const sum = mine.reduce((s, b) => s + b.amount, lump);
      const id = await attempt("vendors", l, (sp) =>
        insertVendor(sp, actor, {
          name: l.v.name, gstin: l.v.gstin, stateCode, mobile: l.v.mobile, address: l.v.address, creditDays: l.v.creditDays, notes: "", openingBalance: moneyText(sum),
        }),
      );
      if (id === null) continue;
      const days = l.v.creditDays ? Number(l.v.creditDays) : 0;
      for (const b of mine) {
        await tx.insert(openingBills).values({
          vendorId: id, billNo: b.billNo, billDate: b.billDate, dueDate: b.dueDate ?? addDays(b.billDate, days), amountPaise: b.amount, createdBy: actor.id,
        });
      }
    }
    for (const p of parties) {
      if (!keyOf.has(p.key)) say("vendorBills", p.row, header("vendorBills", "party"), `No vendor with this name or GSTIN on the "Vendors" sheet.`);
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
