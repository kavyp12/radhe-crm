import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { Workbook } from "exceljs";
import { NextRequest } from "next/server";
import { beforeAll, expect, test } from "vitest";
import { GET } from "@/app/export/[name]/route";
import { db } from "@/db";
import { accounts, customers, jobs, journalEntries, journalLines, printJobs, productCategories } from "@/db/schema";
import { signedIn, testOwner } from "@/db/test-owner";
import { advancesOn, onAccountSources, paidTowardsPrintJobs } from "@/lib/allocations";
import { createCustomer } from "@/lib/customers";
import { loadDashboard } from "@/lib/dashboard";
import { todayIST } from "@/lib/dates";
import { cancelInvoice, createInvoice, issueInvoice } from "@/lib/invoices";
import { createJob } from "@/lib/jobs";
import { ledger } from "@/lib/ledger";
import { createNote, invoiceLinesLeft, issueNote } from "@/lib/notes";
import { excelRupees } from "@/lib/num";
import type { Role, SessionUser } from "@/lib/permissions";
import { cancelPurchaseBill, createPurchaseBill, listPurchaseBills } from "@/lib/purchase-bills";
import { cancelReceipt, createReceipt } from "@/lib/receipts";
import { columnTotal, type Report, type ReportTable } from "@/lib/report";
import { collectionReport } from "@/lib/reports";
import { advanceReport, collectionPersonReport, outstandingReport, pendingPaymentReport, salesPersonReport, salesReport } from "@/lib/reports-sales";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";
import { createVendor } from "@/lib/vendors";
import { createVendorPayment, vendorOpeningBills } from "@/lib/vendor-payments";

// T32 (S20 #1, 3, 11, 12, 17, 18): each report ties out — Sales = the dashboard's Sales and the journal's sales −
// returns, Outstanding = AR, person-wise totals = the overall totals, Pending payment = the open vendor bills = the
// vendor's AP, Advance received = on-account money + job advances — and opens only for the roles A§8 allows.
// Other test files share the DB: hand-checked figures use May 2026 (no other file dates documents there); whole-DB
// checks compare against direct queries.

let owner: SessionUser;
const staff: Partial<Record<Role | "collector", SessionUser>> = {};
const MAY = { period: "custom", from: "01/05/2026", to: "31/05/2026" };
const ids: Record<string, number> = {};
const names: Record<string, string> = {};

const total = (t: ReportTable, key = "total") => columnTotal(t, key);
const mainOf = (r: { report: Report } | null) => r!.report.tables[0];

beforeAll(async () => {
  owner = await testOwner();
  for (const [key, role, canViewCost] of [["sales", "sales", false], ["collector", "sales", false], ["accountant", "accountant", false]] as const) {
    const user = { name: `RA ${key}`, username: `ra.${key}`, role: role as Role, canViewCost };
    staff[key] = { ...user, id: await createUser(owner, { ...user, password: `${key}-pass-123` }) };
  }
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const [cash] = await db.select().from(accounts).where(eq(accounts.systemKey, "cash"));
  const [catA, catB] = await db.select().from(productCategories).orderBy(productCategories.id).limit(2);
  Object.assign(ids, { cash: cash.id, catA: catA.id, catB: catB.id });
  Object.assign(names, { catA: catA.name, catB: catB.name });

  const customer = (name: string, salesPersonId = "", collectionPersonId = "") =>
    createCustomer(owner, {
      name, firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
      creditLimit: "", creditDays: "0", isCreditCustomer: false, salesPersonId, collectionPersonId, notes: "",
    });
  const line = (category: number, qty: string, rate: string, discount = "") =>
    ({ lineId: "", categoryId: String(category), description: "Board", hsnSac: "", width: "", height: "", qty, unit: "Nos", rate, discount, gst: "18" });
  const invoice = async (kind: "tax" | "estimate", customerId: number, date: string, lines: object[]) => {
    const id = await createInvoice(owner, { kind, customerId: String(customerId), date, terms: "", notes: "", lines: JSON.stringify(lines) });
    await issueInvoice(owner, id);
    return id;
  };
  const note = async (kind: "credit" | "debit", invoiceId: number, date: string, amount: string, position = 0) => {
    const lines = await invoiceLinesLeft(db, kind, invoiceId);
    const id = await createNote(owner, kind, invoiceId, { date, reason: "Correction", notes: "", lines: JSON.stringify([{ invoiceLineId: String(lines[position].id), qty: "", amount }]) });
    await issueNote(owner, kind, id);
    return id;
  };
  const receipt = async (customerId: number, date: string, amount: string, allocations: object[] = [], receivedBy = owner.id) =>
    (await createReceipt(owner, {
      customerId: String(customerId), date, amount, mode: "cash", moneyAccountId: String(cash.id), reference: "", chequeNo: "",
      chequeDate: "", receivedBy, notes: "", allocations: JSON.stringify(allocations),
    })).id!;

  // May 2026: C1 (sales person + collection person), C2 and C3 unassigned.
  const c1 = await customer("RA Assigned Customer", staff.sales!.id, staff.collector!.id);
  const c2 = await customer("RA Plain Customer");
  const c3 = await customer("RA Advance Customer");
  Object.assign(ids, { c1, c2, c3 });
  // I1: 2 × ₹1,000 − ₹100 (cat A) + 1 × ₹500 (cat B), 18% → ₹1,900 + ₹500 + GST ₹342 + ₹90 = ₹2,832.
  const i1 = await invoice("tax", c1, "05/05/2026", [line(catA.id, "2", "1,000", "100"), line(catB.id, "1", "500")]);
  const e1 = await invoice("estimate", c2, "06/05/2026", [line(catA.id, "1", "3,000")]);
  const i2 = await invoice("tax", c1, "07/05/2026", [line(catA.id, "1", "100")]);
  await cancelInvoice(owner, i2, "Wrong customer"); // nets to zero on its own date (D45)
  await createInvoice(owner, { kind: "tax", customerId: String(c1), date: "08/05/2026", terms: "", notes: "", lines: JSON.stringify([line(catA.id, "1", "999")]) }); // a draft
  await note("debit", i1, "10/05/2026", "200"); // ₹200 + ₹36 on line A
  await note("credit", i1, "12/05/2026", "300", 1); // ₹300 + ₹54 on line B, settles part of I1
  await receipt(c1, "05/05/2026", "1,000", [{ target: "invoice", id: String(i1), amount: "1,000" }]);
  await receipt(c2, "06/05/2026", "500", [{ target: "invoice", id: String(e1), amount: "500" }], staff.collector!.id);
  await cancelReceipt(owner, await receipt(c1, "07/05/2026", "50"), "Bounced");

  // C3: ₹2,000 on account, a ₹700 advance on a job, and ₹100 of credit-note leftover on a paid estimate.
  await receipt(c3, "15/05/2026", "2,000");
  const job = await createJob(owner, {
    customerId: String(c3), date: "15/05/2026", siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "",
    lines: JSON.stringify([line(catA.id, "1", "5,000")]),
  });
  await receipt(c3, "16/05/2026", "700", [{ target: "job", id: String(job), amount: "700" }]);
  const i3 = await invoice("estimate", c3, "17/05/2026", [line(catA.id, "1", "1,000")]);
  await receipt(c3, "17/05/2026", "1,000", [{ target: "invoice", id: String(i3), amount: "1,000" }]);
  await note("credit", i3, "18/05/2026", "100");

  // Vendor V1: B1 ₹1,180 (₹400 paid), B2 ₹590, B3 cancelled, B4 ₹118 paid in full.
  const v1 = await createVendor(owner, { name: "RA Vendor", gstin: "", stateCode: "24", mobile: "", address: "", creditDays: "", notes: "" });
  ids.v1 = v1;
  const [rent] = await db.execute<{ id: string }>(sql`select id from expense_categories where name = 'Rent'`);
  const bill = async (no: string, date: string, rate: string) =>
    (await createPurchaseBill(owner, {
      vendorId: String(v1), vendorBillNo: no, date, roundOff: "", notes: "",
      lines: JSON.stringify([{ what: `cat:${rent.id}`, description: "", qty: "1", rate, gst: "18", jobId: "" }]),
    })).id!;
  const pay = (date: string, amount: string, billId: number) =>
    createVendorPayment(owner, {
      vendorId: String(v1), date, amount, mode: "cash", moneyAccountId: String(cash.id), reference: "", chequeNo: "", chequeDate: "", notes: "",
      allocations: JSON.stringify([{ id: String(billId), amount }]),
    });
  ids.b1 = await bill("RA-1", "05/05/2026", "1,000");
  ids.b2 = await bill("RA-2", "20/05/2026", "500");
  await cancelPurchaseBill(owner, await bill("RA-3", "08/05/2026", "200"), "Duplicate");
  const b4 = await bill("RA-4", "09/05/2026", "100");
  await pay("06/05/2026", "400", ids.b1);
  await pay("09/05/2026", "118", b4);
}, 60000);

test("Sales: invoice + estimate + debit-note lines − credit notes in May, by line / kind / view; = the journal's sales − returns", async () => {
  const r = (await salesReport(owner, MAY))!;
  const main = mainOf(r);
  expect(main.rows.map((x) => [x.kind, x.taxable, x.gst])).toEqual([
    ["Invoice", 1900_00n, 342_00n],
    ["Invoice", 500_00n, 90_00n],
    ["Estimate", 3000_00n, 0n],
    ["Debit note", 200_00n, 36_00n],
    ["Credit note", -300_00n, -54_00n],
    ["Estimate", 1000_00n, 0n],
    ["Credit note", -100_00n, 0n],
  ]);
  expect([total(main, "taxable"), total(main, "gst"), total(main)]).toEqual([6200_00n, 414_00n, 6614_00n]);
  expect(r.report.tables[1].rows).toEqual([
    { kind: "Invoice", taxable: 2400_00n, gst: 432_00n, total: 2832_00n },
    { kind: "Estimate", taxable: 4000_00n, gst: 0n, total: 4000_00n },
    { kind: "Debit note", taxable: 200_00n, gst: 36_00n, total: 236_00n },
    { kind: "Credit note", taxable: -400_00n, gst: -54_00n, total: -454_00n },
  ]);
  expect(main.rows[0].href).toMatch(/^\/invoices\/\d+$/);
  expect(main.rows[3].href).toMatch(/^\/credit-debit-notes\/dn\/\d+$/);

  // The journal agrees: sales − sales returns posted in May (the cancelled invoice and its reversal net to zero).
  const [j] = await db
    .select({ net: sql<string>`coalesce(sum(${journalLines.creditPaise} - ${journalLines.debitPaise}), 0)` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(inArray(accounts.systemKey, ["sales", "sales_returns"]), gte(journalEntries.date, "2026-05-01"), lte(journalEntries.date, "2026-05-31")));
  expect(BigInt(j.net)).toBe(6200_00n);

  // Views and filters.
  const view = async (q: Record<string, string>) => mainOf(await salesReport(owner, { ...MAY, ...q })).rows;
  const byCategory: [string, bigint][] = [[names.catA, 6000_00n], [names.catB, 200_00n]];
  expect((await view({ view: "category" })).map((x) => [x.category, x.taxable])).toEqual(byCategory.sort((a, b) => a[0].localeCompare(b[0])));
  expect((await view({ view: "customer" })).map((x) => [x.customer, x.taxable])).toEqual([
    ["RA Advance Customer", 900_00n],
    ["RA Assigned Customer", 2300_00n],
    ["RA Plain Customer", 3000_00n],
  ]);
  expect((await view({ view: "date" })).map((x) => [x.date, x.taxable])).toEqual([
    ["2026-05-05", 2400_00n], ["2026-05-06", 3000_00n], ["2026-05-10", 200_00n], ["2026-05-12", -300_00n], ["2026-05-17", 1000_00n], ["2026-05-18", -100_00n],
  ]);
  expect(total({ columns: [], rows: await view({ kind: "estimate" }) }, "taxable")).toBe(3900_00n);
  expect(total({ columns: [], rows: await view({ category: String(ids.catB) }) }, "taxable")).toBe(200_00n);
  expect(total({ columns: [], rows: await view({ salesPerson: staff.sales!.id }) }, "taxable")).toBe(2300_00n);
  expect(total({ columns: [], rows: await view({ salesPerson: "none" }) }, "taxable")).toBe(3900_00n);
  expect((await salesReport(owner, { ...MAY, salesPerson: "someone-else" }))!.report.filters).not.toContainEqual(expect.stringMatching(/^Sales person/));
});

test("Sales total = the dashboard's Sales (this month, today); sales-person-wise totals = the overall totals", async () => {
  const dash = await loadDashboard(owner, todayIST());
  const stat = (key: string) => dash.kpis.concat(dash.today).find((s) => s.key === key)!.paise;
  expect(total(mainOf(await salesReport(owner, { period: "month" })), "taxable")).toBe(stat("sales"));
  expect(total(mainOf(await salesReport(owner, { period: "today" })), "taxable")).toBe(stat("todaySales"));

  for (const q of [MAY, { period: "fy" }]) {
    const all = mainOf(await salesReport(owner, q));
    const persons = mainOf(await salesPersonReport(owner, q));
    for (const key of ["taxable", "gst", "total"]) expect(total(persons, key)).toBe(total(all, key));
  }
  const may = mainOf(await salesPersonReport(owner, MAY)).rows;
  expect(may.map((x) => [x.salesPerson, x.taxable])).toEqual([
    ["RA sales", 2300_00n],
    ["Not assigned", 3900_00n],
  ]);
  expect(may[0].href).toBe(`/reports/sales?period=custom&from=01%2F05%2F2026&to=31%2F05%2F2026&salesPerson=${staff.sales!.id}`);
});

test("Outstanding = AR (customer- and invoice-wise, aging); a period narrows the documents", async () => {
  const ar = (await ledger({ account: "ar" })).closing;
  const r = (await outstandingReport(owner, {}))!;
  expect(r.period).toBe("all");
  expect(total(mainOf(r))).toBe(ar);
  expect(total(r.report.tables[1], "amount")).toBe(ar); // aging buckets + opening / on account
  // Each customer's row = their AR balance.
  for (const row of mainOf(r).rows.slice(0, 20)) {
    const id = Number(String(row.href).split("=")[1]);
    expect(row.total).toBe((await ledger({ account: "ar", customerId: id })).closing);
  }
  const docs = mainOf(await outstandingReport(owner, { view: "invoice" }));
  expect(total(docs, "open")).toBe(ar - total(mainOf(r), "onAccount"));

  const may = await outstandingReport(owner, { ...MAY });
  expect(mainOf(may).rows.map((x) => [x.customer, x.total])).toEqual(
    expect.arrayContaining([["RA Assigned Customer", 1714_00n], ["RA Plain Customer", 2500_00n]]),
  );
  expect(total(mainOf(may))).toBe(4214_00n); // I1 ₹2,832 − ₹1,000 − CN ₹354 + DN ₹236 + E1 ₹2,500
  expect(mainOf(may).columns.some((c) => c.key === "onAccount")).toBe(false);
  const mayDocs = mainOf(await outstandingReport(owner, { ...MAY, view: "invoice" }));
  expect(mayDocs.rows.map((x) => [x.kind, x.open, x.aging, x.status])).toEqual([
    ["Invoice", 1478_00n, "60+ days", "Overdue"],
    ["Estimate", 2500_00n, "60+ days", "Overdue"],
    ["Debit note", 236_00n, "60+ days", "Overdue"],
  ]);
  const mine = mainOf(await outstandingReport(owner, { salesPerson: staff.sales!.id }));
  expect(mine.rows.map((x) => x.customer)).toEqual(["RA Assigned Customer"]);
  expect(total(mine)).toBe((await ledger({ account: "ar", customerId: ids.c1 })).closing);
});

test("Collection-person-wise: receipts by the customer's collection person (received by as a column); totals = Collection", async () => {
  const people = mainOf(await collectionPersonReport(owner, MAY));
  expect(people.rows.map((x) => [x.person, x.count, x.amount])).toEqual([
    ["RA collector", 1n, 1000_00n],
    ["Not assigned", 4n, 4200_00n],
  ]);
  for (const q of [MAY, { period: "fy" }]) {
    const overall = total(mainOf(await collectionReport(owner, q)), "amount");
    expect(total(mainOf(await collectionPersonReport(owner, q)), "amount")).toBe(overall);
    expect(total(mainOf(await collectionPersonReport(owner, { ...q, view: "lines" })), "amount")).toBe(overall);
  }
  const lines = mainOf(await collectionPersonReport(owner, { ...MAY, view: "lines", person: staff.collector!.id }));
  expect(lines.rows.map((x) => [x.customer, x.person, x.receivedBy, x.amount])).toEqual([["RA Assigned Customer", "RA collector", "Owner", 1000_00n]]);
  expect(lines.rows[0].href).toMatch(/^\/receipts\/\d+$/);
  // Sales users may open it (A§8), but not receipts: no links.
  const forSales = mainOf(await collectionPersonReport(staff.sales!, { ...MAY, view: "lines" }));
  expect(forSales.rows.every((x) => x.href === null)).toBe(true);
  expect(mainOf(await collectionPersonReport(owner, { ...MAY, receivedBy: staff.collector!.id, view: "lines" })).rows.map((x) => x.amount)).toEqual([500_00n]);
});

test("Pending payment = open vendor bills = the vendor's AP; whole DB = Σ open of the bills list", async () => {
  const mine = mainOf(await pendingPaymentReport(owner, { vendor: String(ids.v1) }));
  expect(mine.rows.map((x) => [x.vendorBillNo, x.total, x.open, x.status])).toEqual([
    ["RA-1", 1180_00n, 780_00n, "Overdue"],
    ["RA-2", 590_00n, 590_00n, "Overdue"],
  ]);
  expect(total(mine, "open")).toBe(-(await ledger({ account: "ap", vendorId: ids.v1 })).closing);
  expect(mine.rows[0].href).toBe(`/purchase-bills/${ids.b1}`);
  expect(mainOf(await pendingPaymentReport(staff.accountant!, { vendor: String(ids.v1) })).rows[0].href).toBe(`/vendors/${ids.v1}`); // no can_view_cost

  const all = await pendingPaymentReport(owner, {});
  const open = (await listPurchaseBills()).filter((b) => b.status === "active" && b.open > 0n);
  const opening = await vendorOpeningBills(); // T43: vendors' opening bills are pending payments too
  expect(total(mainOf(all), "open")).toBe(open.reduce((s, b) => s + b.open, 0n) + opening.reduce((s, b) => s + b.open, 0n));
  expect(total(all!.report.tables[1], "amount")).toBe(total(mainOf(all), "open"));
  expect(total(mainOf(await pendingPaymentReport(owner, MAY)), "open")).toBe(1370_00n); // bill dates in May: only RA's
});

test("Advance received = on-account money (receipts, credit-note leftovers) + job advances not yet invoiced", async () => {
  const may = await advanceReport(owner, MAY);
  expect(mainOf(may).rows.map((x) => [x.type, x.job === null ? null : "job", x.amount])).toEqual([
    ["On account (receipt)", null, 2000_00n],
    ["Job advance", "job", 700_00n],
    ["Credit note (unused)", null, 100_00n],
  ]);
  expect(total(mainOf(may), "amount")).toBe(2800_00n);

  const all = mainOf(await advanceReport(owner, {}));
  let onAccount = 0n;
  for (const c of await db.select({ id: customers.id }).from(customers)) {
    for (const s of await onAccountSources(db, c.id)) onAccount += s.rest;
  }
  const jobIds = (await db.select({ id: jobs.id }).from(jobs)).map((j) => j.id);
  const advances = [...(await advancesOn(db, jobIds)).values()].reduce((s, v) => s + v, 0n);
  expect(advances).toBeGreaterThanOrEqual(700_00n);
  // + money on print jobs not yet billed (T37), whichever test file made them.
  const printJobIds = (await db.select({ id: printJobs.id }).from(printJobs)).map((p) => p.id);
  const onPrints = [...(await paidTowardsPrintJobs(db, printJobIds)).values()].reduce((s, v) => s + v, 0n);
  expect(total(all, "amount")).toBe(onAccount + advances + onPrints);
  expect(total(mainOf(await advanceReport(owner, { type: "job" })), "amount")).toBe(advances);
});

test("roles: sales opens sales / outstanding / person-wise only; exports carry the page's figures", async () => {
  const sales = staff.sales!;
  expect(await salesReport(sales, MAY)).not.toBeNull();
  expect(await outstandingReport(sales, {})).not.toBeNull();
  expect(await salesPersonReport(sales, MAY)).not.toBeNull();
  expect(await collectionPersonReport(sales, MAY)).not.toBeNull();
  expect(await pendingPaymentReport(sales, {})).toBeNull();
  expect(await advanceReport(sales, {})).toBeNull();
  expect(await collectionReport(sales, MAY)).toBeNull();

  const get = (name: string, query: string, headers: Headers) =>
    GET(new NextRequest(`http://localhost/export/${name}?${query}`, { headers }), { params: Promise.resolve({ name }) });
  const salesHeaders = await signedIn("ra.sales", "sales-pass-123");
  const may = "period=custom&from=01%2F05%2F2026&to=31%2F05%2F2026";
  const xlsx = await get("sales", may, salesHeaders);
  expect(xlsx.status).toBe(200);
  const book = new Workbook();
  await book.xlsx.load(Buffer.from(await xlsx.arrayBuffer()) as unknown as Parameters<typeof book.xlsx.load>[0]);
  const rows = Array.from(book.worksheets[0].getSheetValues(), (r) => (Array.isArray(r) ? r.slice(1) : []));
  expect(rows.find((r) => r[0] === "Total (7 rows)")!.slice(6, 9)).toEqual([excelRupees(6200_00n), excelRupees(414_00n), excelRupees(6614_00n)]);
  expect((await get("outstanding", "", salesHeaders)).status).toBe(200);
  expect((await get("collection-person", may, salesHeaders)).status).toBe(200);
  expect((await get("pending-payment", "", salesHeaders)).status).toBe(403);
  expect((await get("advances", "", salesHeaders)).status).toBe(403);
  const pdf = await get("pending-payment", "format=pdf", await signedIn("ra.accountant", "accountant-pass-123"));
  expect([pdf.status, pdf.headers.get("content-type")]).toEqual([200, "application/pdf"]);
}, 30000);
