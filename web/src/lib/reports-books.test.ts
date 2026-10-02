import { and, eq, gte, lte, sql } from "drizzle-orm";
import { Workbook } from "exceljs";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts, expenseCategories, expenses, journalEntries, journalLines, purchaseBillLines, purchaseBills } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { createCustomer } from "@/lib/customers";
import { loadDashboard } from "@/lib/dashboard";
import { todayIST } from "@/lib/dates";
import { BALANCE_FORMAT, reportXlsx } from "@/lib/excel";
import { cancelExpense, createExpense } from "@/lib/expenses";
import { createInvoice, issueInvoice } from "@/lib/invoices";
import { createJob } from "@/lib/jobs";
import { ledger } from "@/lib/ledger";
import type { SessionUser } from "@/lib/permissions";
import { cancelPurchaseBill, createPurchaseBill, updatePurchaseBill } from "@/lib/purchase-bills";
import { taxableOf } from "@/lib/purchase-lines";
import { createReceipt } from "@/lib/receipts";
import { columnTotal, type ReportTable } from "@/lib/report";
import { canOpenReport, REPORT_INDEX } from "@/lib/reports";
import {
  bankBookReport,
  cashBookReport,
  customerLedgerReport,
  expenseReport,
  purchaseReport,
  stockValuationReport,
  vendorLedgerReport,
} from "@/lib/reports-books";
import { saveBooks } from "@/lib/settings";
import { createItem } from "@/lib/stock";
import { createStockIssue } from "@/lib/stock-issues";
import { createUser } from "@/lib/users";
import { createVendor } from "@/lib/vendors";
import { createVendorPayment } from "@/lib/vendor-payments";

// T33 (S20 #4, 5, 6, 7, 14, 15, 16): ledger closings = the AR / AP balances, the purchase total = the bills' taxable
// (GST per head = the gst_in_* movements), the expense total = expenses, cash / bank book closings = ledger(), and the
// stock valuation = the stock account as of the date. Hand-checked figures use July 2026 (no other test file dates
// documents there); whole-DB checks compare against ledger() and direct queries.

let owner: SessionUser;
let plain: SessionUser; // accountant without can_view_cost
const JULY = { period: "custom", from: "01/07/2026", to: "31/07/2026" };
const ids: Record<string, number> = {};
const total = (t: ReportTable, key: string) => columnTotal(t, key);
const between = (from: string, to: string) => and(gte(journalEntries.date, from), lte(journalEntries.date, to));

/** Dr − Cr of a system account's lines dated in [from, to]. */
async function movement(key: string, from: string, to: string) {
  const [row] = await db
    .select({ net: sql<string>`coalesce(sum(${journalLines.debitPaise} - ${journalLines.creditPaise}), 0)` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(accounts.systemKey, key), between(from, to)));
  return BigInt(row.net);
}

beforeAll(async () => {
  owner = await testOwner();
  const u = { name: "RB Plain Accountant", username: "rb.plain", role: "accountant", canViewCost: false } as const;
  plain = { ...u, id: await createUser(owner, { ...u, password: "rb-plain-pass-1" }) };
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const money: Record<string, number> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.isMoney, true))) money[a.systemKey!] = a.id;
  const category = async (name: string) => (await db.select().from(expenseCategories).where(eq(expenseCategories.name, name)))[0].id;
  const [productCategory] = await db.execute<{ id: string }>(sql`select id from product_categories order by id limit 1`);

  const customer = await createCustomer(owner, {
    name: "RB Ledger Customer", firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
    creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
  });
  const line = { lineId: "", categoryId: productCategory.id, description: "Board", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate: "1,000", discount: "", gst: "18" };
  const estimate = await createInvoice(owner, { kind: "estimate", customerId: String(customer), date: "05/07/2026", terms: "", notes: "", lines: JSON.stringify([line]) });
  await issueInvoice(owner, estimate);
  await createReceipt(owner, {
    customerId: String(customer), date: "10/07/2026", amount: "600", mode: "cash", moneyAccountId: String(money.cash), reference: "", chequeNo: "",
    chequeDate: "", receivedBy: "", notes: "", allocations: JSON.stringify([{ target: "invoice", id: String(estimate), amount: "600" }]),
  });
  const job = await createJob(owner, {
    customerId: String(customer), date: "01/07/2026", siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "",
    lines: JSON.stringify([line]),
  });

  const sheet = await createItem(owner, { name: "RB Sheet", unit: "Sheet", categoryId: String(await category("Acrylic")), hsnSac: "", gstPercent: "18" });
  const panel = await createItem(owner, { name: "RB Panel", unit: "Nos", categoryId: String(await category("ACP")), hsnSac: "", gstPercent: "18" });
  const vendor = (name: string, stateCode: string) => createVendor(owner, { name, gstin: "", stateCode, mobile: "", address: "", creditDays: "", notes: "" });
  const local = await vendor("RB Local Vendor", "24");
  const outside = await vendor("RB Outside Vendor", "27");
  const bill = (vendorId: number, no: string, date: string, lines: object[]) => ({
    vendorId: String(vendorId), vendorBillNo: no, date, roundOff: "", notes: "", lines: JSON.stringify(lines),
  });
  // B1 (same state): 10 sheets × ₹100 + transport ₹250 for the job, 18% → ₹1,475. B2 (other state): panels, edited
  // from 2 to 3 × ₹1,000 + IGST → ₹3,540. B3 cancelled.
  const b1 = (await createPurchaseBill(owner, bill(local, "RB-1", "05/07/2026", [
    { what: `item:${sheet}`, description: "", qty: "10", rate: "100", gst: "18", jobId: "" },
    { what: `cat:${await category("Transport")}`, description: "Truck", qty: "1", rate: "250", gst: "18", jobId: String(job) },
  ]))).id!;
  const panels = (qty: string) => [{ what: `item:${panel}`, description: "", qty, rate: "1,000", gst: "18", jobId: "" }];
  const b2 = (await createPurchaseBill(owner, bill(outside, "RB-2", "06/07/2026", panels("2")))).id!;
  await updatePurchaseBill(owner, b2, bill(outside, "RB-2", "06/07/2026", panels("3")), "Short-billed");
  const b3 = (await createPurchaseBill(owner, bill(outside, "RB-3", "07/07/2026", panels("1")))).id!;
  await cancelPurchaseBill(owner, b3, "Duplicate");
  await createVendorPayment(owner, {
    vendorId: String(local), date: "08/07/2026", amount: "500", mode: "cash", moneyAccountId: String(money.cash), reference: "", chequeNo: "",
    chequeDate: "", notes: "", allocations: JSON.stringify([{ id: String(b1), amount: "500" }]),
  });
  await createStockIssue(owner, { kind: "issue", jobId: String(job), date: "20/07/2026", notes: "", lines: JSON.stringify([{ itemId: String(sheet), qty: "4" }]) });

  // Expenses: Rent ₹1,200 cash, Labour ₹800 from Bank 1 for the job, a cancelled ₹300.
  const spend = (date: string, amount: string, name: string, account: string, jobId = "") =>
    category(name).then((c) => createExpense(owner, { date, amount, categoryId: String(c), mode: account === "cash" ? "cash" : "bank", moneyAccountId: String(money[account]), notes: "", vendorId: "", jobId }));
  await spend("05/07/2026", "1,200", "Rent", "cash");
  await spend("06/07/2026", "800", "Labour", "bank_1", String(job));
  await cancelExpense(owner, (await spend("07/07/2026", "300", "Rent", "cash")).id!, "Entered twice");
  Object.assign(ids, { customer, job, sheet, panel, local, outside, b1, b2, cash: money.cash, bank1: money.bank_1 });
}, 60000);

test("customer ledger: one customer's lines + running balance; all customers' closings add up to AR", async () => {
  const one = (await customerLedgerReport(owner, { ...JULY, customer: String(ids.customer) }))!.report.tables[0];
  expect(one.rows.map((r) => [String(r.document).split(" ")[0], r.debit, r.credit, r.balance])).toEqual([
    ["Opening", null, null, 0n],
    ["Estimate", 1000_00n, null, 1000_00n],
    ["Receipt", null, 600_00n, 400_00n],
    ["Closing", null, null, 400_00n],
  ]);
  expect(one.rows[1].href).toMatch(/^\/invoices\/\d+$/);
  expect([total(one, "debit"), total(one, "credit")]).toEqual([1000_00n, 600_00n]);
  expect(one.rows.at(-1)!.balance).toBe((await ledger({ account: "ar", customerId: ids.customer })).closing);

  const all = (await customerLedgerReport(owner, JULY))!.report.tables;
  const [totals] = all[1].rows;
  expect(totals.closing).toBe((await ledger({ account: "ar" }, undefined, "2026-07-31")).closing);
  expect(totals.opening).toBe((await ledger({ account: "ar" }, "2026-07-01", "2026-07-31")).opening);
  expect(all[0].rows.find((r) => r.party === "RB Ledger Customer")).toMatchObject({ opening: 0n, debit: 1000_00n, credit: 600_00n, closing: 400_00n });
  for (const row of all[0].rows.slice(0, 15)) {
    const customerId = Number(new URL(`http://x${row.href}`).searchParams.get("customer"));
    expect(row.closing).toBe((await ledger({ account: "ar", customerId }, undefined, "2026-07-31")).closing);
  }
  expect(all[0].rows[0].href).toMatch(/^\/reports\/customer-ledger\?period=custom&from=01%2F07%2F2026&to=31%2F07%2F2026&customer=\d+$/);
});

test("vendor ledger: Cr = we owe; all vendors' closings add up to AP; Excel keeps balances as signed numbers", async () => {
  const r = (await vendorLedgerReport(owner, { ...JULY, vendor: String(ids.local) }))!;
  const one = r.report.tables[0];
  expect(one.rows.map((x) => x.balance)).toEqual([0n, -1475_00n, -975_00n, -975_00n]);
  expect(one.rows.at(-1)!.balance).toBe((await ledger({ account: "ap", vendorId: ids.local })).closing);
  const all = (await vendorLedgerReport(owner, JULY))!.report.tables[1].rows[0];
  expect(all.closing).toBe((await ledger({ account: "ap" }, undefined, "2026-07-31")).closing);

  const book = new Workbook();
  await book.xlsx.load((await reportXlsx(r.report)) as unknown as Parameters<typeof book.xlsx.load>[0]);
  const sheet = book.worksheets[0];
  const closing = sheet.getRows(1, sheet.rowCount)!.find((row) => row.getCell(2).value === "Closing balance")!;
  expect([closing.getCell(6).value, closing.getCell(6).numFmt]).toEqual([-975, BALANCE_FORMAT]);
});

test("purchase: active lines of active bills — taxable = the bills' lines, GST per head = the gst_in_* movements; cost only", async () => {
  const r = (await purchaseReport(owner, JULY))!;
  const [lines, totals] = r.report.tables;
  expect(lines.rows.map((x) => [x.what, x.qty, x.taxable, x.gst])).toEqual([
    ["RB Sheet", 10_000n, 1000_00n, 180_00n],
    ["Transport", 1_000n, 250_00n, 45_00n],
    ["RB Panel", 3_000n, 3000_00n, 540_00n],
  ]);
  expect(totals.rows).toEqual([{ taxable: 4250_00n, cgst: 112_50n, sgst: 112_50n, igst: 540_00n, total: 5015_00n }]);

  // Ties: the bills' active lines (direct) and the GST accounts' movement in July (the edit and the cancel net out).
  const direct = await db
    .select({ qtyMilli: purchaseBillLines.qtyMilli, ratePaise: purchaseBillLines.ratePaise })
    .from(purchaseBillLines)
    .innerJoin(purchaseBills, eq(purchaseBills.id, purchaseBillLines.billId))
    .where(and(eq(purchaseBills.status, "active"), eq(purchaseBillLines.active, true), gte(purchaseBills.date, "2026-07-01"), lte(purchaseBills.date, "2026-07-31")));
  expect(total(lines, "taxable")).toBe(direct.reduce((s, l) => s + taxableOf(l), 0n));
  for (const head of ["cgst", "sgst", "igst"] as const) expect(totals.rows[0][head]).toBe(await movement(`gst_in_${head}`, "2026-07-01", "2026-07-31"));

  const view = async (v: string) => (await purchaseReport(owner, { ...JULY, view: v }))!.report.tables[0].rows;
  expect((await view("vendor")).map((x) => [x.vendor, x.taxable, x.cgst, x.igst, x.total])).toEqual([
    ["RB Local Vendor", 1250_00n, 112_50n, 0n, 1475_00n],
    ["RB Outside Vendor", 3000_00n, 0n, 540_00n, 3540_00n],
  ]);
  expect((await view("job")).map((x) => [x.job === "No job" ? "none" : "job", x.taxable])).toEqual([["job", 250_00n], ["none", 4000_00n]]); // "No job" last
  expect((await view("item")).map((x) => [x.what, x.qty, x.unit])).toEqual([["RB Panel", 3_000n, "Nos"], ["RB Sheet", 10_000n, "Sheet"], ["Transport", 1_000n, null]]);
  expect(await purchaseReport(plain, JULY)).toBeNull(); // purchase rates: can_view_cost only
});

test("expense: active expenses = the dashboard's Expense; views by category / job / money account", async () => {
  const july = (await expenseReport(owner, JULY))!.report.tables[0];
  expect(july.rows.map((x) => [x.category, x.account, x.amount])).toEqual([
    ["Rent", "Cash", 1200_00n],
    ["Labour", "Bank 1", 800_00n],
  ]);
  const [direct] = await db
    .select({ paise: sql<string>`coalesce(sum(${expenses.amountPaise}), 0)` })
    .from(expenses)
    .where(and(eq(expenses.status, "active"), gte(expenses.date, "2026-07-01"), lte(expenses.date, "2026-07-31")));
  expect(total(july, "amount")).toBe(BigInt(direct.paise));
  const dash = await loadDashboard(owner, todayIST());
  expect(total((await expenseReport(owner, { period: "month" }))!.report.tables[0], "amount")).toBe(dash.kpis.find((s) => s.key === "expense")!.paise);

  const view = async (v: string) => (await expenseReport(owner, { ...JULY, view: v }))!.report.tables[0].rows;
  expect((await view("category")).map((x) => [x.category, x.count, x.amount])).toEqual([["Labour", 1n, 800_00n], ["Rent", 1n, 1200_00n]]);
  expect((await view("account")).map((x) => [x.account, x.amount])).toEqual([["Bank 1", 800_00n], ["Cash", 1200_00n]]);
  expect((await view("job")).map((x) => x.amount)).toEqual([800_00n, 1200_00n]); // the job, then "No job"
  expect(await expenseReport(plain, JULY)).not.toBeNull();
});

test("cash and bank books: per account opening + received − paid = closing = ledger(); running balances", async () => {
  // Accounts in chart order (codes 1001–1005).
  for (const [load, keys] of [[cashBookReport, ["cash", "petty_cash"]], [bankBookReport, ["upi", "bank_1", "bank_2"]]] as const) {
    const r = (await load(owner, JULY))!;
    const [summary, ...books] = r.report.tables;
    expect(summary.rows).toHaveLength(keys.length);
    for (const [i, key] of keys.entries()) {
      const l = await ledger({ account: key }, "2026-07-01", "2026-07-31");
      const row = summary.rows[i];
      expect([row.opening, row.closing]).toEqual([l.opening, l.closing]);
      expect((row.opening as bigint) + (row.received as bigint) - (row.paid as bigint)).toBe(row.closing);
      if (books[i].rows.length) expect(books[i].rows.at(-1)!.balance).toBe(l.closing);
    }
  }
  // Only the picked account; my July cash lines with their running balance steps.
  const cash = (await cashBookReport(owner, { ...JULY, account: String(ids.cash) }))!.report.tables;
  expect(cash).toHaveLength(2);
  const mine = cash[1].rows.filter((x) => ["05", "07", "08", "10"].some((d) => x.date === `2026-07-${d}`));
  expect(mine.map((x) => [x.received, x.paid])).toEqual(
    expect.arrayContaining([[null, 1200_00n], [null, 300_00n], [300_00n, null], [null, 500_00n], [600_00n, null]]),
  );
  const bank = (await bankBookReport(owner, { ...JULY, account: String(ids.bank1) }))!.report.tables[1];
  expect(bank.rows.find((x) => x.date === "2026-07-06" && x.paid === 800_00n)?.href).toMatch(/^\/expenses\/\d+$/);
});

test("stock valuation as of a date: qty, value, average per item by category; total = the stock account; cost only", async () => {
  const at = async (to: string) => (await stockValuationReport(owner, { period: "custom", from: "", to }))!.report.tables;
  const july = await at("31/07/2026");
  const mine = july[0].rows.filter((x) => String(x.item).startsWith("RB "));
  expect(mine.map((x) => [x.category, x.item, x.qty, x.unit, x.average, x.value])).toEqual([
    ["ACP", "RB Panel", 3_000n, "Nos", 1000_00n, 3000_00n],
    ["Acrylic", "RB Sheet", 6_000n, "Sheet", 100_00n, 600_00n], // 10 bought, 4 issued on 20/07
  ]);
  expect(total(july[0], "value")).toBe((await ledger({ account: "stock" }, undefined, "2026-07-31")).closing);
  expect(total(july[1], "value")).toBe(total(july[0], "value"));
  const mid = await at("15/07/2026");
  expect(mid[0].rows.find((x) => x.item === "RB Sheet")).toMatchObject({ qty: 10_000n, value: 1000_00n });
  expect(total(mid[0], "value")).toBe((await ledger({ account: "stock" }, undefined, "2026-07-15")).closing);
  expect((await at("04/07/2026"))[0].rows.some((x) => String(x.item).startsWith("RB "))).toBe(false);
  const today = (await stockValuationReport(owner, { period: "today" }))!.report.tables[0];
  expect(total(today, "value")).toBe((await ledger({ account: "stock" }, undefined, todayIST())).closing);
  expect(await stockValuationReport(plain, {})).toBeNull();
});

test("the reports list: cost-only reports are hidden without can_view_cost; sales sees its four", () => {
  const names = (user: Pick<SessionUser, "role" | "canViewCost">) => REPORT_INDEX.filter((r) => canOpenReport(user as SessionUser, r)).map((r) => r.name);
  expect(names(owner)).toHaveLength(19); // + the journal (T36)
  expect(names(plain)).not.toContain("purchase");
  expect(names(plain)).not.toContain("journal");
  expect(names(plain)).not.toContain("stock-valuation");
  expect(names(plain)).toContain("customer-ledger");
  expect(names({ role: "sales", canViewCost: true })).toEqual(["sales", "outstanding", "sales-person", "collection-person"]);
  expect(names({ role: "production", canViewCost: false })).toEqual([]);
});
