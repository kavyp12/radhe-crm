import { mkdir, writeFile } from "node:fs/promises";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts, expenseCategories, invoiceLines, jobs, journalEntries, journalLines, productCategories } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { createCustomer } from "@/lib/customers";
import { loadDashboard } from "@/lib/dashboard";
import { todayIST } from "@/lib/dates";
import { reportXlsx } from "@/lib/excel";
import { gstinCheckChar } from "@/lib/gstin";
import { createExpense } from "@/lib/expenses";
import { cancelInvoice, createInvoice, createInvoiceFromJobs, issueInvoice, updateInvoice } from "@/lib/invoices";
import { addJobCost, jobCosting } from "@/lib/job-costing";
import { createJob } from "@/lib/jobs";
import { lineText } from "@/lib/lines";
import { createNote, invoiceLinesLeft, issueNote } from "@/lib/notes";
import { reportPdf } from "@/lib/pdf";
import type { SessionUser } from "@/lib/permissions";
import { createPurchaseBill } from "@/lib/purchase-bills";
import { columnTotal, type ReportTable } from "@/lib/report";
import { gstReport, jobProfitReport, productReport, profitReport } from "@/lib/reports-profit";
import { salesReport } from "@/lib/reports-sales";
import { saveBooks } from "@/lib/settings";
import { createItem } from "@/lib/stock";
import { createStockIssue } from "@/lib/stock-issues";
import { createUser } from "@/lib/users";
import { createVendor } from "@/lib/vendors";

// T34 (S20 #8, 9, 10, 13): P&L profit = the dashboard's Profit (and its gross profit line = the dashboard's), job-wise
// profit = T27 for each job, the product-wise sales total = the Sales report's, and the GST summary's output / input /
// net per head = the gst_out_* / gst_in_* movements. Hand-checked figures use 1–15 Aug 2026 (no other test file dates
// documents there): the S11 job (₹1,00,000 sale over two categories, ₹62,000 costs), B2B / B2C / other-state invoices,
// a debit and a credit note, purchases.

let owner: SessionUser;
let plain: SessionUser; // accountant without can_view_cost
const AUG = { period: "custom", from: "01/08/2026", to: "15/08/2026" };
const ids: Record<string, number> = {};
const total = (t: ReportTable, key: string) => columnTotal(t, key);

/** Cr − Dr of a system account's lines dated in [from, to]. */
async function credit(key: string, from = "2026-08-01", to = "2026-08-15") {
  const [row] = await db
    .select({ net: sql<string>`coalesce(sum(${journalLines.creditPaise} - ${journalLines.debitPaise}), 0)` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(accounts.systemKey, key), gte(journalEntries.date, from), lte(journalEntries.date, to)));
  return BigInt(row.net);
}

beforeAll(async () => {
  owner = await testOwner();
  const u = { name: "RP3 Plain Accountant", username: "rp3.plain", role: "accountant", canViewCost: false } as const;
  plain = { ...u, id: await createUser(owner, { ...u, password: "rp3-plain-pass-1" }) };
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const [cash] = await db.select().from(accounts).where(eq(accounts.systemKey, "cash"));
  const category = async (name: string) => (await db.select().from(expenseCategories).where(eq(expenseCategories.name, name)))[0].id;
  const [catA, catB] = await db.select().from(productCategories).orderBy(productCategories.id).limit(2);
  Object.assign(ids, { catA: catA.id, catB: catB.id });

  const customer = (name: string, gstin: string, stateCode: string) =>
    createCustomer(owner, {
      name, firmName: "", mobile: "", email: "", gstin, stateCode, billingAddress: "", siteAddress: "",
      creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
    });
  const b2b = await customer("RP3 B2B Customer", `24AAPFU0939F1Z${gstinCheckChar("24AAPFU0939F1Z")}`, "24");
  const retail = await customer("RP3 Retail Customer", "", "24");
  const outside = await customer("RP3 Outside Customer", "", "27");
  const line = (cat: number, hsn: string, qty: string, rate: string, gst = "18") =>
    ({ lineId: "", categoryId: String(cat), description: "Board", hsnSac: hsn, width: "", height: "", qty, unit: "Nos", rate, discount: "", gst });
  const invoice = async (kind: "tax" | "estimate", customerId: number, date: string, lines: object[]) => {
    const id = await createInvoice(owner, { kind, customerId: String(customerId), date, terms: "", notes: "", lines: JSON.stringify(lines) });
    await issueInvoice(owner, id);
    return id;
  };
  const note = async (kind: "credit" | "debit", invoiceId: number, date: string, amount: string) => {
    const [first] = await invoiceLinesLeft(db, kind, invoiceId);
    const id = await createNote(owner, kind, invoiceId, { date, reason: "Correction", notes: "", lines: JSON.stringify([{ invoiceLineId: String(first.id), qty: "", amount }]) });
    await issueNote(owner, kind, id);
  };

  // The S11 job: ₹60,000 (cat A, HSN 9405) + ₹40,000 (cat B, HSN 4911); material ₹42,000, labour ₹8,000, transport
  // ₹2,000, installation ₹6,000 (a purchase bill line), printing ₹4,000 (manual) → profit ₹38,000.
  const job = await createJob(owner, {
    customerId: String(b2b), date: "01/08/2026", siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "",
    lines: JSON.stringify([line(catA.id, "9405", "1", "60,000"), line(catB.id, "4911", "1", "40,000")]),
  });
  const sheet = await createItem(owner, { name: "RP3 Sheet", unit: "Sheet", categoryId: String(await category("Acrylic")), hsnSac: "", gstPercent: "18", openingQty: "42", openingRate: "1000" });
  await createStockIssue(owner, { kind: "issue", jobId: String(job), date: "02/08/2026", notes: "", lines: JSON.stringify([{ itemId: String(sheet), qty: "42" }]) });
  const spend = async (date: string, name: string, amount: string, jobId = "") =>
    createExpense(owner, { date, amount, categoryId: String(await category(name)), mode: "cash", moneyAccountId: String(cash.id), notes: "", vendorId: "", jobId });
  await spend("03/08/2026", "Labour", "8,000", String(job));
  await spend("03/08/2026", "Transport", "2,000", String(job));
  const vendor = (name: string, stateCode: string) => createVendor(owner, { name, gstin: "", stateCode, mobile: "", address: "", creditDays: "", notes: "" });
  const localVendor = await vendor("RP3 Local Vendor", "24");
  const outsideVendor = await vendor("RP3 Outside Vendor", "27");
  const bill = async (vendorId: number, no: string, date: string, name: string, rate: string, gst: string, jobId = "") =>
    createPurchaseBill(owner, {
      vendorId: String(vendorId), vendorBillNo: no, date, roundOff: "", notes: "",
      lines: JSON.stringify([{ what: `cat:${await category(name)}`, description: "", qty: "1", rate, gst, jobId }]),
    });
  await bill(localVendor, "RP3-INST", "04/08/2026", "Installation", "6,000", "0", String(job));
  await addJobCost(owner, job, { bucket: "printing", date: "04/08/2026", amount: "4,000", note: "In-house print" });
  const draft = await createInvoiceFromJobs(owner, [job], "tax");
  const saved = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, draft)).orderBy(invoiceLines.position);
  await updateInvoice(owner, draft, { kind: "tax", customerId: String(b2b), date: "05/08/2026", terms: "", notes: "", lines: JSON.stringify(saved.map(lineText)) });
  await issueInvoice(owner, draft);

  // Other sales: B2C ₹10,000 (cat A, 18%) + a ₹1,000 debit note; other state ₹20,000 (cat B, 12%) + a ₹2,000 credit
  // note; an estimate ₹3,000; a cancelled invoice.
  const i2 = await invoice("tax", retail, "06/08/2026", [line(catA.id, "9405", "2", "5,000")]);
  const i3 = await invoice("tax", outside, "07/08/2026", [line(catB.id, "4911", "1", "20,000", "12")]);
  await invoice("estimate", retail, "08/08/2026", [line(catA.id, "", "1", "3,000")]);
  await cancelInvoice(owner, await invoice("tax", b2b, "06/08/2026", [line(catA.id, "9405", "1", "500")]), "Wrong rate");
  await note("debit", i2, "09/08/2026", "1,000");
  await note("credit", i3, "10/08/2026", "2,000");
  // Purchases: ₹10,000 + 18% same state, ₹5,000 + 18% other state.
  await bill(localVendor, "RP3-P1", "11/08/2026", "Electricity", "10,000", "18");
  await bill(outsideVendor, "RP3-P2", "12/08/2026", "Electrical Material", "5,000", "18");
  ids.job = job;
}, 60000);

test("P&L: income − expense accounts from the journal, grouped; net profit and the D59 gross profit line", async () => {
  const r = (await profitReport(owner, AUG))!;
  const [pnl, profit, gross] = r.report.tables;
  expect(pnl.rows.map((x) => [x.group, x.account, x.income ?? x.expense])).toEqual([
    ["Sales", "Sales", 134000_00n],
    ["Returns", "Sales Returns", -2000_00n],
    ["Materials consumed", "Materials Consumed", 42000_00n],
    ["Expense categories", "Electrical Material", 5000_00n],
    ["Expense categories", "Electricity", 10000_00n],
    ["Expense categories", "Installation", 6000_00n],
    ["Expense categories", "Labour", 8000_00n],
    ["Expense categories", "Transport", 2000_00n],
  ]);
  expect([total(pnl, "income"), total(pnl, "expense")]).toEqual([132000_00n, 73000_00n]);
  expect(profit.rows.map((x) => x.amount)).toEqual([132000_00n, 73000_00n, 59000_00n]);
  // Gross profit (D59): sales ₹1,32,000 − job costs in the books ₹58,000 − manual ₹4,000.
  expect(gross.rows.map((x) => x.amount)).toEqual([132000_00n, 58000_00n, 4000_00n, 70000_00n]);
  expect(await profitReport(plain, AUG)).toBeNull();

  // The dashboard's Profit and Gross profit for this month = the report's for this month.
  const dash = await loadDashboard(owner, todayIST());
  const stat = (key: string) => [...dash.kpis, ...dash.performance].find((s) => s.key === key)!;
  const month = (await profitReport(owner, { period: "month" }))!.report.tables;
  expect(month[1].rows[2].amount).toBe(stat("profit").paise);
  expect(month[2].rows[3].amount).toBe(stat("grossProfit").paise);
  expect(stat("profit").href).toBe("/reports/profit?period=month");

  await mkdir(".samples", { recursive: true });
  await writeFile(".samples/profit-and-loss.xlsx", await reportXlsx(r.report));
  await writeFile(".samples/profit-and-loss.pdf", await reportPdf(r.report));
}, 30000);

test("job-wise profit = the T27 card for each job", async () => {
  const aug = (await jobProfitReport(owner, AUG))!.report.tables[0];
  const mine = aug.rows.find((x) => x.href === `/jobs/${ids.job}`)!;
  expect(mine).toMatchObject({
    status: "Invoiced", sale: 100000_00n, material: 42000_00n, labour: 8000_00n, installation: 6000_00n, transport: 2000_00n,
    printing: 4000_00n, other: 0n, cost: 62000_00n, profit: 38000_00n, margin: "38%",
  });
  // Every job this FY: the same figures as its job page.
  const fy = (await jobProfitReport(owner, { period: "fy" }))!.report.tables[0];
  expect(fy.rows.length).toBe((await db.select({ id: jobs.id }).from(jobs).where(gte(jobs.date, "2026-04-01"))).length);
  for (const row of fy.rows) {
    const card = (await jobCosting(owner, Number(String(row.href).split("/")[2])))!;
    expect([row.sale, row.material, row.labour, row.installation, row.transport, row.printing, row.other, row.cost, row.profit]).toEqual([
      card.sale, card.cost.material, card.cost.labour, card.cost.installation, card.cost.transport, card.cost.printing, card.cost.other, card.totalCost, card.profit,
    ]);
  }
  expect(await jobProfitReport(plain, AUG)).toBeNull();
});

test("product-wise: sales by category = the Sales report total; job profit split pro-rata to taxable value", async () => {
  const rows = (await productReport(owner, AUG))!.report.tables[0].rows;
  const byName = Object.fromEntries(rows.map((x) => [x.category, x]));
  const [a, b] = await db.select().from(productCategories).orderBy(productCategories.id).limit(2);
  // A: job ₹60,000 + B2C ₹10,000 + DN ₹1,000 + estimate ₹3,000; B: job ₹40,000 + ₹20,000 − CN ₹2,000.
  expect(byName[a.name]).toMatchObject({ sales: 74000_00n, jobSales: 60000_00n, profit: 22800_00n, margin: "38%" });
  expect(byName[b.name]).toMatchObject({ sales: 58000_00n, jobSales: 40000_00n, profit: 15200_00n, margin: "38%" });
  for (const q of [AUG, { period: "fy" }, { period: "month" }]) {
    const product = (await productReport(owner, q))!.report.tables[0];
    expect(total(product, "sales")).toBe(total((await salesReport(owner, q))!.report.tables[0], "taxable"));
  }
  // Without can_view_cost: sales only.
  const sales = (await productReport(plain, AUG))!.report.tables[0];
  expect(sales.columns.map((c) => c.key)).toEqual(["category", "sales"]);
  expect(sales.rows.every((x) => !("profit" in x))).toBe(true);
});

test("GST summary: output by B2B / B2C, HSN and rate; notes; input; net per head = the GST accounts' movements", async () => {
  const r = (await gstReport(owner, AUG))!;
  const [output, debits, credits, input, net] = r.report.tables;
  const shape = (t: ReportTable) => t.rows.map((x) => [x.type, x.hsn, x.rate, x.taxable, x.cgst, x.sgst, x.igst]);
  expect(shape(output)).toEqual([
    ["B2B", "4911", "18%", 40000_00n, 3600_00n, 3600_00n, 0n],
    ["B2B", "9405", "18%", 60000_00n, 5400_00n, 5400_00n, 0n],
    ["B2C", "4911", "12%", 20000_00n, 0n, 0n, 2400_00n],
    ["B2C", "9405", "18%", 10000_00n, 900_00n, 900_00n, 0n],
  ]);
  expect(shape(debits)).toEqual([["B2C", "9405", "18%", 1000_00n, 90_00n, 90_00n, 0n]]);
  expect(shape(credits)).toEqual([["B2C", "4911", "12%", -2000_00n, 0n, 0n, -240_00n]]);
  expect(input.rows.map((x) => [x.rate, x.taxable, x.cgst, x.sgst, x.igst])).toEqual([
    ["0%", 6000_00n, 0n, 0n, 0n],
    ["18%", 15000_00n, 900_00n, 900_00n, 900_00n],
  ]);
  expect(net.rows.map((x) => [x.head, x.output, x.debit, x.credit, x.input, x.net])).toEqual([
    ["CGST", 9900_00n, 90_00n, 0n, 900_00n, 9090_00n],
    ["SGST", 9900_00n, 90_00n, 0n, 900_00n, 9090_00n],
    ["IGST", 2400_00n, 0n, -240_00n, 900_00n, 1260_00n],
  ]);

  // Per head, for this window and for the whole FY: output + notes = the output account's credit, input = the input
  // account's debit (the cancelled invoice and its reversal net out; estimates post no GST).
  for (const [q, from, to] of [[AUG, "2026-08-01", "2026-08-15"], [{ period: "fy" }, "2026-04-01", todayIST()]] as const) {
    const rows = (await gstReport(owner, q))!.report.tables[4].rows;
    for (const row of rows) {
      const head = String(row.head).toLowerCase();
      expect((row.output as bigint) + (row.debit as bigint) + (row.credit as bigint)).toBe(await credit(`gst_out_${head}`, from, to));
      expect(row.input).toBe(-(await credit(`gst_in_${head}`, from, to)));
      expect(row.net).toBe((await credit(`gst_out_${head}`, from, to)) + (await credit(`gst_in_${head}`, from, to)));
    }
  }
  // Without can_view_cost the purchases' taxable value is left out.
  expect((await gstReport(plain, AUG))!.report.tables[3].columns.map((c) => c.key)).toEqual(["rate", "cgst", "sgst", "igst", "tax"]);

  await mkdir(".samples", { recursive: true });
  await writeFile(".samples/gst-summary.xlsx", await reportXlsx(r.report));
  await writeFile(".samples/gst-summary.pdf", await reportPdf(r.report));
}, 30000);
