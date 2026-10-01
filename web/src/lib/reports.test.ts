import { mkdir, writeFile } from "node:fs/promises";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { Workbook } from "exceljs";
import { NextRequest } from "next/server";
import { beforeAll, expect, test } from "vitest";
import { GET } from "@/app/export/[name]/route";
import { db } from "@/db";
import { accounts, expenseCategories, receipts } from "@/db/schema";
import { OWNER, signedIn, testOwner } from "@/db/test-owner";
import { createCustomer } from "@/lib/customers";
import { INR_FORMAT, reportXlsx } from "@/lib/excel";
import { excelRupees } from "@/lib/num";
import { reportPdf } from "@/lib/pdf";
import type { SessionUser } from "@/lib/permissions";
import { cancelReceipt, createReceipt } from "@/lib/receipts";
import { columnTotal } from "@/lib/report";
import { collectionReport } from "@/lib/reports";
import { saveBooks } from "@/lib/settings";
import { createItem } from "@/lib/stock";
import { createUser } from "@/lib/users";

// T31 (S20, S27, D59): a report is one shape — page, Excel and PDF come from the same loader. The Collection report
// totals = active receipts in the period; Excel money cells are numbers in the ₹ format; exports keep the page's
// permission stripping (no cost columns without can_view_cost).

let owner: SessionUser;
let collector: SessionUser;
const acct: Record<string, number> = {};
const period = { period: "custom", from: "15/04/2026", to: "17/04/2026" };

beforeAll(async () => {
  owner = await testOwner();
  const c = { name: "RP Collector", username: "rp.collector", role: "sales", canViewCost: false } as const;
  collector = { ...c, id: await createUser(owner, { ...c, password: "collector-pass-1" }) };
  await createUser(owner, { name: "RP Accountant", username: "rp.acct", role: "accountant", canViewCost: false, password: "rp-acct-pass-1" });
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  for (const a of await db.select().from(accounts).where(eq(accounts.isMoney, true))) acct[a.systemKey!] = a.id;
});

const customer = (name: string) =>
  createCustomer(owner, {
    name, firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
    creditLimit: "", creditDays: "0", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
  });
const receipt = async (customerId: number, date: string, amount: string, mode: "cash" | "upi" | "bank", account: string) =>
  (await createReceipt(owner, {
    customerId: String(customerId), date, amount, mode, moneyAccountId: String(acct[account]), reference: "", chequeNo: "",
    chequeDate: "", receivedBy: collector.id, notes: "", allocations: "[]",
  })).id!;
const get = (name: string, query: string, headers?: Headers) =>
  GET(new NextRequest(`http://localhost/export/${name}?${query}`, { headers }), { params: Promise.resolve({ name }) });

test("Collection report: totals = active receipts in the period, by mode; Excel and PDF carry the same figures", async () => {
  const c = await customer("RP Collection Customer");
  await receipt(c, "15/04/2026", "1,000", "cash", "cash");
  await receipt(c, "16/04/2026", "2,500.50", "upi", "upi");
  const bounced = await receipt(c, "16/04/2026", "700", "cash", "cash");
  await cancelReceipt(owner, bounced, "Bounced");
  await receipt(c, "17/04/2026", "10,00,000", "bank", "bank_1");
  await receipt(c, "18/04/2026", "300", "cash", "cash"); // after the period

  const mine = (await collectionReport(owner, { ...period, receivedBy: collector.id }))!;
  const [list, modes] = mine.report.tables;
  expect(list.rows.map((r) => [r.date, r.mode, r.account, r.receivedBy, r.amount])).toEqual([
    ["2026-04-15", "Cash", "Cash", "RP Collector", 1000_00n],
    ["2026-04-16", "UPI", "UPI", "RP Collector", 2500_50n],
    ["2026-04-17", "Bank transfer", "Bank 1", "RP Collector", 1000000_00n],
  ]);
  expect(columnTotal(list, "amount")).toBe(1003500_50n);
  expect(modes.rows).toEqual([
    { mode: "Cash", count: 1n, amount: 1000_00n },
    { mode: "UPI", count: 1n, amount: 2500_50n },
    { mode: "Bank transfer", count: 1n, amount: 1000000_00n },
  ]);
  expect(mine.report.filters).toEqual(["Period: 15/04/2026 – 17/04/2026", "Received by: RP Collector"]);
  expect((await collectionReport(owner, { ...period, receivedBy: collector.id, mode: "cash" }))!.report.tables[0].rows).toHaveLength(1);

  // Unfiltered, the total is every active receipt in the period (whatever other tests added).
  const all = (await collectionReport(owner, period))!.report.tables;
  const [direct] = await db
    .select({ paise: sql<string>`coalesce(sum(${receipts.amountPaise}), 0)` })
    .from(receipts)
    .where(and(eq(receipts.status, "active"), gte(receipts.date, "2026-04-15"), lte(receipts.date, "2026-04-17")));
  expect(columnTotal(all[0], "amount")).toBe(BigInt(direct.paise));
  expect(columnTotal(all[1], "amount")).toBe(BigInt(direct.paise));

  // Excel: opens with exceljs; title block; money cells are numbers in the ₹ format; dates are dates; same totals.
  const xlsx = await reportXlsx(mine.report);
  const book = new Workbook();
  await book.xlsx.load(xlsx as unknown as Parameters<typeof book.xlsx.load>[0]);
  const sheet = book.worksheets[0];
  const inr = INR_FORMAT.replaceAll("\\", ""); // exceljs drops the format's backslash escapes when it reads a file
  const rows = Array.from(sheet.getSheetValues(), (r) => (Array.isArray(r) ? r.slice(1) : [])); // sparse → dense
  expect(rows[1][0]).toBe("Collection report");
  expect(rows[2][0]).toBe("Period: 15/04/2026 – 17/04/2026 · Received by: RP Collector");
  expect(String(rows[3][0])).toMatch(/^Generated \d\d\/\d\d\/\d{4} \d\d:\d\d [AP]M$/);
  const header = rows.findIndex((r) => r[0] === "Date");
  expect(rows[header]).toEqual(["Date", "Receipt no.", "Customer", "Mode", "Money account", "Received by", "Amount"]);
  const first = sheet.getRow(header + 1);
  expect(first.getCell(1).value).toEqual(new Date(Date.UTC(2026, 3, 15)));
  expect(first.getCell(1).numFmt).toBe("dd/mm/yyyy");
  expect(first.getCell(7).value).toBe(1000);
  expect(first.getCell(7).numFmt).toBe(inr);
  const totals = sheet.getRow(header + 4);
  expect([totals.getCell(1).value, totals.getCell(7).value, totals.getCell(7).numFmt]).toEqual(["Total (3 rows)", 1003500.5, inr]);
  expect(totals.getCell(7).value).toBe(excelRupees(columnTotal(list, "amount")));
  const modeTotal = rows.findLast((r) => String(r[0]).startsWith("Total"))!;
  expect(modeTotal[2]).toBe(1003500.5);

  // PDF renders (A4 table); both saved for a look.
  const pdf = await reportPdf(mine.report);
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  await mkdir(".samples", { recursive: true });
  await writeFile(".samples/collection.xlsx", xlsx);
  await writeFile(".samples/collection.pdf", pdf);
}, 30000);

test("exports keep the page's permissions: no cost columns without can_view_cost; reports only for owner / accountant", async () => {
  const owners = await signedIn(OWNER.username, OWNER.password);
  const accountant = await signedIn("rp.acct", "rp-acct-pass-1"); // can_view_cost off
  const sales = await signedIn("rp.collector", "collector-pass-1");
  const sheetOf = async (res: Response) => {
    const book = new Workbook();
    await book.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as Parameters<typeof book.xlsx.load>[0]);
    return Array.from(book.worksheets[0].getSheetValues(), (r) => (Array.isArray(r) ? r.slice(1) : []));
  };
  const headerOf = async (res: Response) => (await sheetOf(res)).find((r) => r[0] === "Item");
  const [acrylic] = await db.select().from(expenseCategories).where(eq(expenseCategories.name, "Acrylic"));
  await createItem(owner, { name: "RP Qty Sheet", unit: "Sheet", categoryId: String(acrylic.id), hsnSac: "", gstPercent: "18", openingQty: "12.5", openingRate: "100" });

  expect((await get("items", "", undefined)).status).toBe(401);
  const full = await get("items", "", owners);
  expect(full.headers.get("content-disposition")).toMatch(/^attachment; filename="Items-\d\d-\d\d-\d{4}\.xlsx"$/);
  const fullSheet = await sheetOf(full);
  expect(fullSheet.find((r) => r[0] === "Item")).toEqual(["Item", "Category", "In stock", "Unit", "Status", "Average cost", "Stock value"]);
  // D60: the quantity is a number in Excel, its unit in a column of its own.
  expect(fullSheet.find((r) => r[0] === "RP Qty Sheet")!.slice(2, 4)).toEqual([12.5, "Sheet"]);
  expect(await headerOf(await get("items", "", accountant))).toEqual(["Item", "Category", "In stock", "Unit", "Status"]);
  expect((await get("purchase-bills", "", accountant)).status).toBe(403); // purchase rates: the whole list is cost
  expect((await get("purchase-bills", "", owners)).status).toBe(200);

  expect((await get("collection", "", sales)).status).toBe(403);
  const pdf = await get("collection", "period=month&format=pdf", accountant);
  expect([pdf.status, pdf.headers.get("content-type")]).toEqual([200, "application/pdf"]);
  expect((await get("nothing", "", owners)).status).toBe(404);
  expect((await get("constructor", "", owners)).status).toBe(404);
}, 30000);
