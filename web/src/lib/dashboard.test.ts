import { and, eq, gte, inArray, isNotNull, lte, or, sql, type Column } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import {
  accounts,
  creditNoteLines,
  creditNotes,
  debitNoteLines,
  debitNotes,
  expenseCategories,
  expenses,
  invoiceLines,
  invoices,
  jobCostEntries,
  journalEntries,
  journalLines,
  purchaseBillLines,
  purchaseBills,
  receipts,
} from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { createCustomer } from "@/lib/customers";
import { loadDashboard, type Dashboard } from "@/lib/dashboard";
import { formatDate, fyStart, todayIST } from "@/lib/dates";
import { cancelExpense, createExpense } from "@/lib/expenses";
import { createInvoice, issueInvoice } from "@/lib/invoices";
import { addJobCost } from "@/lib/job-costing";
import { createJob } from "@/lib/jobs";
import { ledger } from "@/lib/ledger";
import { createNote, invoiceLinesLeft, issueNote } from "@/lib/notes";
import { lineCalc } from "@/lib/num";
import type { Role, SessionUser } from "@/lib/permissions";
import { createPurchaseBill } from "@/lib/purchase-bills";
import { taxableOf } from "@/lib/purchase-lines";
import { cancelReceipt, createReceipt } from "@/lib/receipts";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";
import { createVendor } from "@/lib/vendors";

// T30 (S19, R1, A§12, D24, D59, D60): every dashboard figure equals a direct check on the books — Sales vs invoice lines
// + debit notes − credit notes, Collection vs receipts, Outstanding − Advances = AR, Payable = AP, Cash / Bank vs ledger(), Profit vs
// journal income − expense, Gross profit vs Sales − job costs in the period — and each role sees only its figures.
// Other test files share the DB, so the checks run over everything in it.

let owner: SessionUser;
const staff: Partial<Record<Role, SessionUser>> = {};
const today = todayIST();
const month = `${today.slice(0, 8)}01`;
const fy = fyStart(today);

const value = (d: Dashboard, key: string) => [...d.kpis, ...d.today, ...d.current, ...d.performance].find((s) => s.key === key)?.paise;
const keys = (d: Dashboard) => [...d.kpis, ...d.today, ...d.current, ...d.performance].map((s) => s.key);
const between = (col: Column, from: string, to: string) => and(gte(col, from), lte(col, to));
const sumOf = <T>(rows: T[], f: (r: T) => bigint) => rows.reduce((s, r) => s + f(r), 0n);

beforeAll(async () => {
  owner = await testOwner();
  for (const [role, canViewCost] of [["accountant", true], ["sales", true], ["production", false]] as [Role, boolean][]) {
    const user = { name: `DB ${role}`, username: `db.${role}`, role, canViewCost };
    staff[role] = { ...user, id: await createUser(owner, { ...user, password: `${role}-pass-123` }) };
  }
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });

  // A month of business: a big invoice + an estimate, a credit note, receipts (one cancelled, one on account), a job
  // with a tagged expense and a manual cost, a purchase bill, an expense (and a cancelled one).
  const [cash] = await db.select().from(accounts).where(eq(accounts.systemKey, "cash"));
  const category = (await db.query.productCategories.findFirst())!.id;
  const expenseCategory = async (name: string) => String((await db.select().from(expenseCategories).where(eq(expenseCategories.name, name)))[0].id);
  const customer = (name: string) =>
    createCustomer(owner, {
      name, firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
      creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
    });
  const line = (rate: string, discount = "") => ({ lineId: "", categoryId: String(category), description: "Board", hsnSac: "", width: "", height: "", qty: "1.5", unit: "Nos", rate, discount, gst: "18" });
  const big = await customer("DB Big Customer");
  const advance = await customer("DB Advance Customer");

  const inv = await createInvoice(owner, { kind: "tax", customerId: String(big), date: formatDate(today), terms: "", notes: "", lines: JSON.stringify([line("33,33,333.33", "10"), line("1,000")]) });
  await issueInvoice(owner, inv);
  const est = await createInvoice(owner, { kind: "estimate", customerId: String(big), date: formatDate(today), terms: "", notes: "", lines: JSON.stringify([line("2,000")]) });
  await issueInvoice(owner, est);
  const [first] = await invoiceLinesLeft(db, "credit", inv);
  const cn = await createNote(owner, "credit", inv, { date: formatDate(today), reason: "Rate corrected", notes: "", lines: JSON.stringify([{ invoiceLineId: String(first.id), qty: "", amount: "1,000" }]) });
  await issueNote(owner, "credit", cn);
  const dn = await createNote(owner, "debit", inv, { date: formatDate(today), reason: "Extra fitting", notes: "", lines: JSON.stringify([{ invoiceLineId: String(first.id), qty: "", amount: "600" }]) });
  await issueNote(owner, "debit", dn);

  const money = { date: formatDate(today), mode: "cash", moneyAccountId: String(cash.id), reference: "", chequeNo: "", chequeDate: "", notes: "", receivedBy: "" };
  await createReceipt(owner, { ...money, customerId: String(big), amount: "5,000", allocations: "[]" });
  const bounced = (await createReceipt(owner, { ...money, customerId: String(big), amount: "900", allocations: "[]" })).id!;
  await cancelReceipt(owner, bounced, "Bounced");
  await createReceipt(owner, { ...money, customerId: String(advance), amount: "7,000", allocations: "[]" }); // on account

  const job = await createJob(owner, {
    customerId: String(big), date: formatDate(today), siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "",
    lines: JSON.stringify([line("10,000")]),
  });
  const spend = { date: formatDate(today), mode: "cash", moneyAccountId: String(cash.id), notes: "", vendorId: "" };
  await createExpense(owner, { ...spend, amount: "800", categoryId: await expenseCategory("Labour"), jobId: String(job) });
  const wrong = (await createExpense(owner, { ...spend, amount: "250", categoryId: await expenseCategory("Rent"), jobId: "" })).id!;
  await cancelExpense(owner, wrong, "Entered twice");
  await createExpense(owner, { ...spend, amount: "1,200", categoryId: await expenseCategory("Rent"), jobId: "" });
  await addJobCost(owner, job, { bucket: "printing", date: formatDate(today), amount: "400", note: "In-house print" });
  const vendor = await createVendor(owner, { name: "DB Vendor", gstin: "", stateCode: "24", mobile: "", address: "", creditDays: "", notes: "" });
  await createPurchaseBill(owner, {
    vendorId: String(vendor), vendorBillNo: "DB-1", date: formatDate(today), roundOff: "", notes: "",
    lines: JSON.stringify([{ what: `cat:${await expenseCategory("Transport")}`, description: "Truck", qty: "2", rate: "1,500.25", gst: "18", jobId: "" }]),
  });
});

/** Issued invoice / estimate lines at their taxable value (num.ts) + issued debit-note − credit-note lines, by document date (D60). */
async function directSales(from: string, to: string) {
  const lines = await db
    .select({ qty: invoiceLines.qtyMilli, rate: invoiceLines.ratePaise, discount: invoiceLines.discountPaise })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(eq(invoices.status, "issued"), between(invoices.date, from, to)));
  const credits = await db
    .select({ taxable: creditNoteLines.taxablePaise })
    .from(creditNoteLines)
    .innerJoin(creditNotes, eq(creditNotes.id, creditNoteLines.noteId))
    .where(and(eq(creditNotes.status, "issued"), between(creditNotes.date, from, to)));
  const debits = await db
    .select({ taxable: debitNoteLines.taxablePaise })
    .from(debitNoteLines)
    .innerJoin(debitNotes, eq(debitNotes.id, debitNoteLines.noteId))
    .where(and(eq(debitNotes.status, "issued"), between(debitNotes.date, from, to)));
  return (
    sumOf(lines, (l) => lineCalc({ qty: l.qty, rate: l.rate, discount: l.discount, gstBp: 0 }, "estimate").taxable) +
    sumOf(debits, (n) => n.taxable) -
    sumOf(credits, (n) => n.taxable)
  );
}
const directCollection = async (from: string, to: string) =>
  sumOf(await db.select().from(receipts).where(and(eq(receipts.status, "active"), between(receipts.date, from, to))), (r) => r.amountPaise);
const directExpense = async (from: string, to: string) =>
  sumOf(await db.select().from(expenses).where(and(eq(expenses.status, "active"), between(expenses.date, from, to))), (r) => r.amountPaise);
async function directPurchase(from: string, to: string) {
  const lines = await db
    .select({ qtyMilli: purchaseBillLines.qtyMilli, ratePaise: purchaseBillLines.ratePaise })
    .from(purchaseBillLines)
    .innerJoin(purchaseBills, eq(purchaseBills.id, purchaseBillLines.billId))
    .where(and(eq(purchaseBills.status, "active"), eq(purchaseBillLines.active, true), between(purchaseBills.date, from, to)));
  return sumOf(lines, taxableOf);
}
const balance = async (...keys: ("ar" | "ap" | "cash" | "petty_cash" | "bank_1" | "bank_2" | "upi")[]) =>
  sumOf(await Promise.all(keys.map((k) => ledger({ account: k }))), (l) => l.closing);

test("owner: each figure equals a direct check on the books", async () => {
  const d = await loadDashboard(owner, today);
  expect(d.kpis.map((s) => s.key)).toEqual(["sales", "collection", "outstanding", "purchase", "expense", "profit", "cash", "bank"]);

  const sales = await directSales(month, today);
  // Seeded: 1.5 × ₹33,33,333.33 = ₹50,00,000.00 (half-up) − ₹10 + 1.5 × ₹1,000 + estimate ₹3,000 − CN ₹1,000 + DN ₹600
  // — plus other files' sales.
  expect(sales).toBeGreaterThanOrEqual(50000_00_00n - 10_00n + 1500_00n + 3000_00n - 1000_00n + 600_00n);
  expect([value(d, "sales"), value(d, "monthlySales")]).toEqual([sales, sales]);
  expect(value(d, "todaySales")).toBe(await directSales(today, today));

  const collection = await directCollection(month, today); // the cancelled ₹900 left out
  expect([value(d, "collection"), value(d, "monthlyCollection"), value(d, "todayCollection")]).toEqual([collection, collection, await directCollection(today, today)]);
  expect([value(d, "purchase"), value(d, "todayPurchase")]).toEqual([await directPurchase(month, today), await directPurchase(today, today)]);
  expect(await directPurchase(today, today)).toBeGreaterThanOrEqual(3000_50n); // 2 × ₹1,500.25, GST excluded
  const expense = await directExpense(month, today);
  expect([value(d, "expense"), value(d, "monthlyExpense"), value(d, "todayExpense")]).toEqual([expense, expense, await directExpense(today, today)]);

  // Outstanding − Advances = AR from the journal; the on-account ₹7,000 is an advance.
  const ar = await balance("ar");
  expect(value(d, "outstanding")! - value(d, "advances")!).toBe(ar);
  expect(value(d, "receivable")).toBe(value(d, "outstanding"));
  expect(value(d, "advances")).toBeGreaterThanOrEqual(7000_00n);
  expect(value(d, "payable")).toBe(-(await balance("ap")));
  expect([value(d, "cash"), value(d, "cashBalance")]).toEqual(Array(2).fill(await balance("cash", "petty_cash")));
  expect([value(d, "bank"), value(d, "bankBalance")]).toEqual(Array(2).fill(await balance("bank_1", "bank_2", "upi")));

  // Profit = income − expense accounts for the month (journal).
  const [p] = await db
    .select({ net: sql<string>`coalesce(sum(${journalLines.creditPaise} - ${journalLines.debitPaise}), 0)` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(inArray(accounts.type, ["income", "expense"]), between(journalEntries.date, month, today)));
  expect(value(d, "profit")).toBe(BigInt(p.net));

  // Gross profit = Sales − job costs dated in the month (job-tagged journal costs + manual entries).
  const [jc] = await db
    .select({ net: sql<string>`coalesce(sum(${journalLines.debitPaise} - ${journalLines.creditPaise}), 0)` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        isNotNull(journalLines.jobId),
        between(journalEntries.date, month, today),
        or(eq(accounts.systemKey, "materials_consumed"), inArray(accounts.id, db.select({ id: expenseCategories.accountId }).from(expenseCategories))),
      ),
    );
  const manual = sumOf(await db.select().from(jobCostEntries).where(and(eq(jobCostEntries.active, true), between(jobCostEntries.date, month, today))), (e) => e.amountPaise);
  expect(manual).toBeGreaterThanOrEqual(400_00n);
  expect(value(d, "grossProfit")).toBe(sales - BigInt(jc.net) - manual);

  // Chart: this FY by month; the last month is this month; the months add up to the FY.
  expect(d.months[0].month).toBe("Apr");
  expect(d.months.at(-1)).toEqual({ month: new Date(`${today}T00:00:00Z`).toLocaleString("en-GB", { month: "short", timeZone: "UTC" }), sales, collection, expense });
  expect(sumOf(d.months, (m) => m.sales)).toBe(await directSales(fy, today));
  expect(sumOf(d.months, (m) => m.collection!)).toBe(await directCollection(fy, today));
  expect(d.topCustomers[0]).toMatchObject({ name: "DB Big Customer" });
  expect(d.topCustomers.length).toBeLessThanOrEqual(5);
  expect(d.topServices.length).toBeGreaterThan(0);

  // Cards link to their source.
  const href = (key: string) => [...d.kpis, ...d.current].find((s) => s.key === key)?.href;
  expect([href("outstanding"), href("cash"), href("bank"), href("purchase"), href("payable")]).toEqual(["/outstanding", "/cash-bank", "/cash-bank", "/purchase-bills", "/vendors"]);
}, 30000);

test("roles: sales gets sales / outstanding / follow-ups only; profit needs can_view_cost; production none", async () => {
  // The sales user has can_view_cost on and still gets no profit, purchase, expense, cash or bank.
  const s = await loadDashboard(staff.sales!, today);
  expect(keys(s)).toEqual(["sales", "outstanding", "todaySales", "receivable", "monthlySales", "performanceOutstanding", "advances"]);
  expect(s.months.every((m) => m.collection === undefined && m.expense === undefined)).toBe(true);
  expect(s.followUps).not.toBeNull();
  expect([...s.kpis, ...s.current].map((x) => x.href)).toEqual(["/reports/sales?period=month", "/outstanding", "/outstanding"]);

  const noProfit = (d: Dashboard) => !keys(d).some((k) => /profit/i.test(k));
  expect(noProfit(await loadDashboard({ ...owner, canViewCost: false }, today))).toBe(true);
  const plain = await loadDashboard({ ...staff.accountant!, canViewCost: false }, today);
  expect(noProfit(plain)).toBe(true);
  expect([...plain.kpis].find((x) => x.key === "purchase")?.href).toBeUndefined(); // purchase bills need can_view_cost
  expect(noProfit(await loadDashboard(staff.accountant!, today))).toBe(false);
  await expect(loadDashboard(staff.production!, today)).rejects.toThrow("Not allowed");
}, 30000);
