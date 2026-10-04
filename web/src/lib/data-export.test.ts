import { mkdir, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { eq, getTableName, sql } from "drizzle-orm";
import { Workbook } from "exceljs";
import { NextRequest } from "next/server";
import { beforeAll, expect, test } from "vitest";
import { GET } from "@/app/export/all-data/route";
import { db } from "@/db";
import { accounts, invoices } from "@/db/schema";
import { OWNER, signedIn, testOwner } from "@/db/test-owner";
import { createCustomer } from "@/lib/customers";
import { canExportAll, EXPORT_TABLES, exportAll, journalReport } from "@/lib/data-export";
import { todayIST } from "@/lib/dates";
import { reportXlsx } from "@/lib/excel";
import { createInvoice, issueInvoice } from "@/lib/invoices";
import { excelRupees } from "@/lib/num";
import { reportPdf } from "@/lib/pdf";
import type { SessionUser } from "@/lib/permissions";
import { createReceipt } from "@/lib/receipts";
import { columnTotal } from "@/lib/report";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";

// T36 (S27, D62): the full export reads back with exceljs — a sheet per table, row counts = the DB's, money cells
// numeric; the journal export's Σ Dr = Σ Cr = the journal for the period; only the owner (with can_view_cost) gets
// the full export. Documents dated 20–21/06/2026.

let owner: SessionUser;
let accountant: SessionUser;
let plain: SessionUser; // accountant without can_view_cost
let sales: SessionUser;
let costlessOwner: SessionUser;
const ids: Record<string, number> = {};

beforeAll(async () => {
  owner = await testOwner();
  const user = async (username: string, role: SessionUser["role"], canViewCost: boolean) => {
    const u = { name: username, username, role, canViewCost };
    return { ...u, id: await createUser(owner, { ...u, password: `${username}-pass-1` }) };
  };
  accountant = await user("dx.acct", "accountant", true);
  plain = await user("dx.plain", "accountant", false);
  sales = await user("dx.sales", "sales", false);
  costlessOwner = await user("dx.owner", "owner", false);
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const [cash] = await db.select().from(accounts).where(eq(accounts.systemKey, "cash"));
  const [category] = await db.execute<{ id: string }>(sql`select id from product_categories order by id limit 1`);
  ids.customer = await createCustomer(owner, {
    name: "DX Export Customer", firmName: "DX Firm", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
    creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
  });
  const line = { lineId: "", categoryId: category.id, description: "Board", hsnSac: "", width: "2.5", height: "1.5", qty: "1.5", unit: "Nos", rate: "1,234.50", discount: "", gst: "18" };
  ids.invoice = await createInvoice(owner, { kind: "tax", customerId: String(ids.customer), date: "20/06/2026", terms: "", notes: "", lines: JSON.stringify([line]) });
  await issueInvoice(owner, ids.invoice);
  await createReceipt(owner, {
    customerId: String(ids.customer), date: "21/06/2026", amount: "1,000.25", mode: "cash", moneyAccountId: String(cash.id), reference: "", chequeNo: "",
    chequeDate: "", receivedBy: "", notes: "", allocations: "[]",
  });
}, 60000);

/** exceljs's load() is typed for an older Buffer. */
async function readXlsx(data: Uint8Array) {
  const book = new Workbook();
  await book.xlsx.load(data as unknown as Parameters<typeof book.xlsx.load>[0]);
  return book;
}

/** Runs the full export into memory and reads it back with exceljs. */
async function exported() {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  await exportAll(out);
  await mkdir(".samples", { recursive: true });
  await writeFile(".samples/all-data.xlsx", Buffer.concat(chunks));
  return readXlsx(Buffer.concat(chunks));
}

/** The sheet's header row and data rows as plain arrays (exceljs rows are 1-based). */
function table(book: Workbook, name: string) {
  const sheet = book.getWorksheet(name)!;
  const values = (n: number) => (sheet.getRow(n).values as unknown[]).slice(1);
  const header = values(1) as string[];
  const rows = Array.from({ length: sheet.rowCount - 1 }, (_, i) => values(i + 2));
  return { header, rows, col: (h: string) => header.indexOf(h) };
}

test("the full export: a sheet per table, row counts = the DB's, money / qty numbers, real dates, ids, no share tokens", async () => {
  const book = await exported();
  expect(book.worksheets.map((w) => w.name)).toEqual(EXPORT_TABLES.map((t) => getTableName(t)));
  for (const t of EXPORT_TABLES) {
    const [{ n }] = await db.execute<{ n: string }>(sql`select count(*) as n from ${t}`);
    expect(book.getWorksheet(getTableName(t))!.rowCount - 1, getTableName(t)).toBe(Number(n));
  }

  const inv = table(book, "invoices");
  expect(inv.header).not.toContain("share_token");
  expect(inv.header).toEqual(expect.arrayContaining(["id", "number", "date", "customer_id", "total_rupees", "round_off_rupees", "created_at"]));
  const [mine] = await db.select().from(invoices).where(eq(invoices.id, ids.invoice));
  const row = inv.rows.find((r) => r[inv.col("id")] === ids.invoice)!;
  expect(row[inv.col("total_rupees")]).toBe(excelRupees(mine.totalPaise)); // 1.5 × ₹1,234.50 + 18% → ₹2,185.07, rounded
  expect(row[inv.col("customer_id")]).toBe(ids.customer);
  expect(row[inv.col("date")]).toEqual(new Date(Date.UTC(2026, 5, 20)));
  expect(row[inv.col("created_at")]).toBeInstanceOf(Date);
  expect(inv.rows.every((r) => typeof r[inv.col("total_rupees")] === "number")).toBe(true);

  const lines = table(book, "invoice_lines");
  const line = lines.rows.find((r) => r[lines.col("invoice_id")] === ids.invoice)!;
  expect([line[lines.col("qty")], line[lines.col("width")], line[lines.col("rate_rupees")], line[lines.col("gst_bp")]]).toEqual([1.5, 2.5, 1234.5, 1800]);

  // Every money cell in the journal is a number, and the sheet balances to the paisa.
  const jl = table(book, "journal_lines");
  const paise = (side: string) => jl.rows.reduce((s, r) => s + Math.round((r[jl.col(side)] as number) * 100), 0);
  expect(jl.rows.every((r) => typeof r[jl.col("debit_rupees")] === "number" && typeof r[jl.col("credit_rupees")] === "number")).toBe(true);
  expect(paise("debit_rupees")).toBe(paise("credit_rupees"));
  const [{ dr }] = await db.execute<{ dr: string }>(sql`select coalesce(sum(debit_paise), 0) as dr from journal_lines`);
  expect(paise("debit_rupees")).toBe(Number(dr));
}, 60000);

test("the journal export: Σ Dr = Σ Cr = the journal for the period; voucher type / no, ledger with party", async () => {
  for (const [q, from, to] of [[{ period: "custom", from: "20/06/2026", to: "21/06/2026" }, "2026-06-20", "2026-06-21"], [{ period: "fy" }, "2026-04-01", todayIST()]] as const) {
    const r = (await journalReport(owner, q))!;
    const t = r.report.tables[0];
    const [{ dr, cr, n }] = await db.execute<{ dr: string; cr: string; n: string }>(sql`
      select coalesce(sum(l.debit_paise), 0) as dr, coalesce(sum(l.credit_paise), 0) as cr, count(*) as n
      from journal_lines l join journal_entries e on e.id = l.entry_id where e.date between ${from} and ${to}`);
    expect(t.rows.length).toBe(Number(n));
    expect(columnTotal(t, "debit")).toBe(BigInt(dr));
    expect(columnTotal(t, "credit")).toBe(BigInt(cr));
    expect(columnTotal(t, "debit")).toBe(columnTotal(t, "credit"));
  }
  const days = (await journalReport(owner, { period: "custom", from: "20/06/2026", to: "21/06/2026" }))!.report;
  const t = days.tables[0];
  expect(t.columns.map((c) => c.label)).toEqual(["Date", "Voucher type", "Voucher no", "Ledger", "Dr", "Cr", "Narration"]);
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, ids.invoice));
  const ar = t.rows.find((r) => r.number === inv.number && String(r.ledger).startsWith("Accounts Receivable"))!;
  expect(ar).toMatchObject({ date: "2026-06-20", type: "Invoice", ledger: "Accounts Receivable · DX Export Customer · DX Firm", debit: inv.totalPaise, credit: null });
  expect(t.rows.some((r) => r.type === "Receipt" && r.credit === 1000_25n && r.ledger === "Accounts Receivable · DX Export Customer · DX Firm")).toBe(true);

  // Excel: the totals row carries Σ Dr = Σ Cr as numbers.
  const fy = (await journalReport(owner, { period: "fy" }))!.report;
  const xlsx = await reportXlsx(fy);
  await mkdir(".samples", { recursive: true });
  await writeFile(".samples/journal.xlsx", xlsx);
  // The sample PDF shows this file's own two days: a year of every test file's entries took 40–90 s to render
  // (react-pdf), so this test's time hung on the rest of the suite (D68).
  await writeFile(".samples/journal.pdf", await reportPdf(days));
  const book = await readXlsx(xlsx);
  const sheet = book.worksheets[0];
  const totals = sheet.getRow(sheet.rowCount);
  expect(String(totals.getCell(1).value)).toMatch(/^Total \(\d+ rows\)$/);
  expect(typeof totals.getCell(5).value).toBe("number");
  expect(totals.getCell(5).value).toBe(totals.getCell(6).value);

  // Owner / accountant with can_view_cost (stock values, materials consumed are in it).
  expect(await journalReport(accountant, { period: "fy" })).not.toBeNull();
  for (const user of [plain, sales, costlessOwner]) expect(await journalReport(user, { period: "fy" }), user.username).toBeNull();
}, 60000);

test("only the owner (with can_view_cost) can run the full export", async () => {
  expect([owner, accountant, plain, sales, costlessOwner].map(canExportAll)).toEqual([true, false, false, false, false]);
  const get = async (headers?: Headers) => GET(new NextRequest("http://localhost/export/all-data", { headers }));
  expect((await get()).status).toBe(401);
  for (const [username, password] of [["dx.acct", "dx.acct-pass-1"], ["dx.sales", "dx.sales-pass-1"], ["dx.owner", "dx.owner-pass-1"]]) {
    expect((await get(await signedIn(username, password))).status, username).toBe(403);
  }
  const res = await get(await signedIn(OWNER.username, OWNER.password));
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="Radhe-CRM-data-\d{2}-\d{2}-\d{4}\.xlsx"$/);
  const book = await readXlsx(new Uint8Array(await res.arrayBuffer()));
  expect(book.worksheets).toHaveLength(EXPORT_TABLES.length);
}, 60000);
