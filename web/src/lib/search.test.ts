import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import {
  accounts, adjustments, creditNotes, debitNotes, expenseCategories, expenses, goodsReceipts, invoices, jobs, materialRequests, purchaseBills,
  purchaseOrders, quotations, receipts, stockAdjustments, stockIssues, transfers, vendorPayments,
} from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { createAdjustment } from "@/lib/adjustments";
import { createCustomer } from "@/lib/customers";
import { createExpense } from "@/lib/expenses";
import { createReceipt as createGrn } from "@/lib/goods-receipts";
import { gstinCheckChar } from "@/lib/gstin";
import { createInvoice, issueInvoice } from "@/lib/invoices";
import { createJob } from "@/lib/jobs";
import { createRequest } from "@/lib/material-requests";
import { createNote, invoiceLinesLeft, issueNote } from "@/lib/notes";
import type { SessionUser } from "@/lib/permissions";
import { createPurchaseBill } from "@/lib/purchase-bills";
import { createOrder, getOrder } from "@/lib/purchase-orders";
import { createQuotation } from "@/lib/quotations";
import { createReceipt } from "@/lib/receipts";
import { search, searchAmount, unpadded, type SearchGroup, type SearchHit } from "@/lib/search";
import { saveBooks } from "@/lib/settings";
import { createItem, createStockAdjustment } from "@/lib/stock";
import { createStockIssue } from "@/lib/stock-issues";
import { createTransfer } from "@/lib/transfers";
import { createUser } from "@/lib/users";
import { createVendor } from "@/lib/vendors";
import { createVendorPayment } from "@/lib/vendor-payments";

// T35 (S26, D62): one test per search type, then the permission rules — a sales user gets no receipt / vendor /
// purchase hits, production gets jobs only and no amount search, and no hit carries a cost field. Documents are dated
// June 2026 (no other test file dates documents there); other files' rows may match too, so tests look for ours.

let owner: SessionUser;
let sales: SessionUser;
let production: SessionUser;
let plain: SessionUser; // accountant without can_view_cost
const doc: Record<string, { id: number; number: string }> = {};
const ids: Record<string, number> = {};

const gstin = (first14: string) => first14 + gstinCheckChar(first14);
const CUSTOMER_GSTIN = gstin("24AABCR1718E1Z");
const VENDOR_GSTIN = gstin("24AAGFA4410K1Z");

/** The hits of one group, or [] when the group isn't there. */
const group = (groups: SearchGroup[], label: string) => groups.find((g) => g.label === label)?.hits ?? [];
const titles = (groups: SearchGroup[], label: string) => group(groups, label).map((h) => h.title);
const labels = (groups: SearchGroup[]) => groups.map((g) => g.label);

beforeAll(async () => {
  owner = await testOwner();
  const user = async (name: string, username: string, role: "sales" | "production" | "accountant") => {
    const u = { name, username, role, canViewCost: false } as const;
    return { ...u, id: await createUser(owner, { ...u, password: `${username}-pass-1` }) };
  };
  sales = await user("SR Sales", "sr.sales", "sales");
  production = await user("SR Production", "sr.production", "production");
  plain = await user("SR Plain Accountant", "sr.plain", "accountant");
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const [cash] = await db.select().from(accounts).where(eq(accounts.systemKey, "cash"));
  const [category] = await db.execute<{ id: string }>(sql`select id from product_categories order by id limit 1`);
  const [rent] = await db.select().from(expenseCategories).where(eq(expenseCategories.name, "Rent"));

  ids.customer = await createCustomer(owner, {
    name: "SR Mahalaxmi Enterprises", firmName: "SR Laxmi Signs", mobile: "98765 43210", email: "", gstin: CUSTOMER_GSTIN, stateCode: "24",
    billingAddress: "", siteAddress: "", creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
  });
  ids.vendor = await createVendor(owner, {
    name: "SR Ambica Flex Printers", gstin: VENDOR_GSTIN, stateCode: "24", mobile: "079-2654 3210", address: "", creditDays: "", notes: "",
  });
  const line = (rate: string, gst = "18") =>
    ({ lineId: "", categoryId: category.id, description: "Board", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate, discount: "", gst });
  const customerId = String(ids.customer);

  const job = await createJob(owner, {
    customerId, date: "10/06/2026", siteAddress: "", siteReference: "SR Iscon Mall facade", vehicleNo: "GJ-01-AB-1234", salesPersonId: "",
    targetDate: "", notes: "", lines: JSON.stringify([line("12,350")]), // ₹14,573.00 with GST
  });
  const quotation = await createQuotation(owner, { customerId, date: "10/06/2026", terms: "", notes: "", lines: JSON.stringify([line("8,000")]) });
  const invoice = async (kind: "tax" | "estimate", rate: string) => {
    const id = await createInvoice(owner, { kind, customerId, date: "11/06/2026", terms: "", notes: "", lines: JSON.stringify([line(rate)]) });
    await issueInvoice(owner, id);
    return id;
  };
  const tax = await invoice("tax", "5,000");
  const estimate = await invoice("estimate", "24,680"); // ₹24,680.00, no GST, no round-off
  const note = async (kind: "credit" | "debit") => {
    const [first] = await invoiceLinesLeft(db, kind, tax);
    const id = await createNote(owner, kind, tax, { date: "12/06/2026", reason: "Correction", notes: "", lines: JSON.stringify([{ invoiceLineId: String(first.id), qty: "", amount: "100" }]) });
    await issueNote(owner, kind, id);
    return id;
  };
  const cn = await note("credit");
  const dn = await note("debit");
  const receipt = (await createReceipt(owner, {
    customerId, date: "13/06/2026", amount: "25,000.50", mode: "cash", moneyAccountId: String(cash.id), reference: "", chequeNo: "", chequeDate: "",
    receivedBy: "", notes: "", allocations: "[]",
  })).id!;
  const bill = (await createPurchaseBill(owner, {
    vendorId: String(ids.vendor), vendorBillNo: "AF/2026/77", date: "14/06/2026", roundOff: "", notes: "",
    lines: JSON.stringify([{ what: `cat:${rent.id}`, description: "", qty: "1", rate: "2,950", gst: "18", jobId: "" }]), // ₹3,481.00
  })).id!;
  const payment = (await createVendorPayment(owner, {
    vendorId: String(ids.vendor), date: "15/06/2026", amount: "1,000", mode: "cash", moneyAccountId: String(cash.id), reference: "", chequeNo: "",
    chequeDate: "", notes: "", allocations: "[]",
  })).id!;
  const expense = (await createExpense(owner, {
    date: "16/06/2026", amount: "25,000.50", categoryId: String(rent.id), mode: "cash", moneyAccountId: String(cash.id), notes: "", vendorId: "", jobId: "",
  })).id!;

  // D63: the purchase / stock chain, a transfer and a JV, found by number.
  const [acp] = await db.select().from(expenseCategories).where(eq(expenseCategories.name, "ACP"));
  const [bank] = await db.select().from(accounts).where(eq(accounts.systemKey, "bank_1"));
  const [capital] = await db.select().from(accounts).where(eq(accounts.systemKey, "capital"));
  const item = await createItem(owner, { name: "SR ACP Sheet", unit: "Sheet", categoryId: String(acp.id), hsnSac: "", gstPercent: "18" });
  const itemLines = (qty: string) => JSON.stringify([{ itemId: String(item), qty }]);
  const mr = (await createRequest(owner, { neededBy: "30/06/2026", jobId: String(job), notes: "", lines: itemLines("10") })).id;
  const po = (await createOrder(owner, {
    vendorId: String(ids.vendor), date: "17/06/2026", notes: "",
    lines: JSON.stringify([{ itemId: String(item), description: "", qty: "10", rate: "1,500", gst: "18", requestLineId: "" }]), // ₹17,700.00
  })).id;
  const [poLine] = (await getOrder(po))!.lines;
  const grn = (await createGrn(owner, { orderId: String(po), date: "17/06/2026", notes: "", lines: JSON.stringify([{ orderLineId: String(poLine.id), qty: "10" }]) })).id!;
  const issue = (await createStockIssue(owner, { kind: "issue", jobId: String(job), date: "17/06/2026", notes: "", lines: itemLines("2") })).id!;
  const adjustment = (await createStockAdjustment(owner, { itemId: String(item), date: "17/06/2026", qty: "-1", rate: "", reason: "Damaged" })).id!;
  const transfer = (await createTransfer(owner, {
    date: "18/06/2026", fromAccountId: String(cash.id), toAccountId: String(bank.id), amount: "4,321", reference: "", notes: "",
  })).id!;
  const jvLines = [{ accountId: String(cash.id), debit: "1,234", credit: "" }, { accountId: String(capital.id), debit: "", credit: "1,234" }];
  const jv = (await createAdjustment(owner, {
    kind: "journal", date: "18/06/2026", narration: "SR capital brought in", customerId: "", amount: "", moneyAccountId: "", allocations: "[]",
    lines: JSON.stringify(jvLines.map((l) => ({ ...l, customerId: "", vendorId: "", jobId: "" }))),
  })).id!;

  const numbered = async (key: string, table: PgTable, id: number) => {
    const [row] = await db.execute<{ number: string }>(sql`select number from ${table} where id = ${id}`);
    doc[key] = { id, number: row.number };
  };
  await numbered("job", jobs, job);
  await numbered("quotation", quotations, quotation);
  await numbered("tax", invoices, tax);
  await numbered("estimate", invoices, estimate);
  await numbered("cn", creditNotes, cn);
  await numbered("dn", debitNotes, dn);
  await numbered("receipt", receipts, receipt);
  await numbered("bill", purchaseBills, bill);
  await numbered("payment", vendorPayments, payment);
  await numbered("expense", expenses, expense);
  await numbered("mr", materialRequests, mr);
  await numbered("po", purchaseOrders, po);
  await numbered("grn", goodsReceipts, grn);
  await numbered("issue", stockIssues, issue);
  await numbered("adjustment", stockAdjustments, adjustment);
  await numbered("transfer", transfers, transfer);
  await numbered("jv", adjustments, jv);
}, 60000);

test("number and amount parsing", () => {
  expect(unpadded("RDS-2026-00125")).toBe("RDS-2026-125");
  expect(unpadded("QT/26-27/0014")).toBe("QT/26-27/14");
  expect(unpadded("QT/26-27/1000")).toBe("QT/26-27/1000");
  expect(unpadded("RDS/26-27/0100")).toBe("RDS/26-27/100");
  expect(["25000", "25,000", "₹25,000", "₹ 25,000.00", "Rs. 25,000/-", "INR 25000"].map(searchAmount)).toEqual(Array(6).fill(25000_00n));
  expect(searchAmount("₹25,000.50")).toBe(25000_50n);
  expect([searchAmount("12,5"), searchAmount("25.505"), searchAmount("Ganesh"), searchAmount("RDS-2026-125"), searchAmount("0")]).toEqual([null, null, null, null, null]);
});

test("customers: a misspelt name, firm, mobile, GSTIN; under 3 characters finds nothing", async () => {
  const mine = "SR Mahalaxmi Enterprises · SR Laxmi Signs";
  for (const q of ["Mahalakshmi", "mahalaxmi enterprises", "Laxmi Signs", "98765", "+91 98765 43210", CUSTOMER_GSTIN, CUSTOMER_GSTIN.slice(2, 12).toLowerCase()]) {
    const hits = group(await search(owner, q), "Customers");
    expect(hits.map((h) => h.title), q).toContain(mine);
    expect(hits.find((h) => h.title === mine)).toEqual({ title: mine, detail: `98765 43210 · ${CUSTOMER_GSTIN}`, href: `/customers/${ids.customer}` });
  }
  expect(titles(await search(owner, "Mahalakshmi"), "Customers")[0]).toBe(mine); // best match first
  expect(await search(owner, "SR")).toEqual([]);
});

test("vendors: a misspelt name, mobile digits, GSTIN", async () => {
  for (const q of ["ambika flex", "Ambica", "26543210", VENDOR_GSTIN.toLowerCase()]) {
    expect(group(await search(owner, q), "Vendors"), q).toContainEqual({
      title: "SR Ambica Flex Printers", detail: `079-2654 3210 · ${VENDOR_GSTIN}`, href: `/vendors/${ids.vendor}`,
    });
  }
});

test("jobs: number with or without padding, site reference, vehicle no", async () => {
  const { id, number } = doc.job;
  const short = unpadded(number); // RDS-2026-00012 → RDS-2026-12
  expect(short).not.toBe(number);
  for (const q of [short, short.toLowerCase(), number, "iscon mall", "GJ01AB1234", "gj 01 ab"]) {
    const hits = group(await search(owner, q), "Jobs");
    expect(hits.map((h) => h.href), q).toContain(`/jobs/${id}`);
  }
  const [first] = group(await search(owner, short), "Jobs");
  expect(first).toMatchObject({ title: number, href: `/jobs/${id}`, amount: "₹14,573.00" }); // exact number first
  expect(first.detail).toBe("SR Mahalaxmi Enterprises · SR Laxmi Signs · SR Iscon Mall facade · GJ-01-AB-1234 · 10/06/2026 · In Production");
});

test("documents by number, with or without zero padding", async () => {
  const cases: [string, string, string][] = [
    ["quotation", "Quotations", `/quotations/${doc.quotation.id}`],
    ["tax", "Invoices & estimates", `/invoices/${doc.tax.id}`],
    ["estimate", "Invoices & estimates", `/invoices/${doc.estimate.id}`],
    ["cn", "Credit notes", `/credit-debit-notes/cn/${doc.cn.id}`],
    ["dn", "Debit notes", `/credit-debit-notes/dn/${doc.dn.id}`],
    ["receipt", "Receipts", `/receipts/${doc.receipt.id}`],
    ["payment", "Vendor payments", `/vendor-payments/${doc.payment.id}`],
    ["bill", "Purchase bills", `/purchase-bills/${doc.bill.id}`],
    ["expense", "Expenses", `/expenses/${doc.expense.id}`],
  ];
  for (const [key, label, href] of cases) {
    const { number } = doc[key];
    for (const q of [number, unpadded(number), unpadded(number).toLowerCase()]) {
      const [first] = group(await search(owner, q), label);
      expect(first, `${key} ${q}`).toMatchObject({ title: number, href });
    }
  }
  const estimate = group(await search(owner, doc.estimate.number), "Invoices & estimates")[0];
  expect(estimate).toEqual({
    title: doc.estimate.number, detail: "Estimate · SR Mahalaxmi Enterprises · SR Laxmi Signs · 11/06/2026", href: `/invoices/${doc.estimate.id}`, amount: "₹24,680.00",
  });
  // A purchase bill is also found by the vendor's own bill no.
  expect(group(await search(owner, "af/2026/77"), "Purchase bills")[0]).toEqual({
    title: doc.bill.number, detail: "SR Ambica Flex Printers · bill AF/2026/77 · 14/06/2026", href: `/purchase-bills/${doc.bill.id}`, amount: "₹3,481.00",
  });
});

test("amounts: with commas, ₹ and paise → documents whose total equals it", async () => {
  for (const q of ["24680", "24,680", "₹24,680"]) {
    expect(group(await search(owner, q), "Invoices & estimates").map((h) => h.href), q).toContain(`/invoices/${doc.estimate.id}`);
  }
  for (const q of ["₹25,000.50", "25000.5", "Rs. 25,000.50"]) {
    const groups = await search(owner, q);
    expect(group(groups, "Receipts").map((h) => h.href), q).toContain(`/receipts/${doc.receipt.id}`);
    expect(group(groups, "Expenses").map((h) => h.href), q).toContain(`/expenses/${doc.expense.id}`);
    expect(group(groups, "Receipts").every((h) => h.amount === "₹25,000.50")).toBe(true);
  }
  expect(group(await search(owner, "₹14,573"), "Jobs").map((h) => h.href)).toContain(`/jobs/${doc.job.id}`);
  expect(group(await search(owner, "₹3,481"), "Purchase bills").map((h) => h.href)).toContain(`/purchase-bills/${doc.bill.id}`);
});

test("a sales user gets no receipt, vendor, vendor payment, purchase or expense hits", async () => {
  const everything = [doc.receipt.number, doc.payment.number, doc.bill.number, doc.expense.number, "₹25,000.50", "Ambica", "af/2026/77"];
  for (const q of everything) {
    const got = labels(await search(sales, q));
    for (const label of ["Receipts", "Vendors", "Vendor payments", "Purchase bills", "Expenses"]) expect(got, q).not.toContain(label);
  }
  // What sales may view still comes back.
  expect(titles(await search(sales, "Mahalakshmi"), "Customers")).toContain("SR Mahalaxmi Enterprises · SR Laxmi Signs");
  expect(group(await search(sales, unpadded(doc.job.number)), "Jobs")[0]).toMatchObject({ href: `/jobs/${doc.job.id}`, amount: "₹14,573.00" });
  expect(group(await search(sales, doc.tax.number), "Invoices & estimates")[0].href).toBe(`/invoices/${doc.tax.id}`);
});

test("a production user gets jobs only, without amounts and without amount search", async () => {
  const groups = await search(production, unpadded(doc.job.number));
  expect(labels(groups)).toEqual(["Jobs"]);
  const [first] = groups[0].hits;
  expect(first).toEqual({ title: doc.job.number, detail: expect.stringContaining("GJ-01-AB-1234"), href: `/jobs/${doc.job.id}` });
  for (const q of ["Mahalakshmi", doc.quotation.number, doc.tax.number, doc.receipt.number, "Ambica", "₹25,000.50"]) expect(await search(production, q), q).toEqual([]);
  expect(group(await search(production, "₹14,573"), "Jobs").map((h) => h.href)).not.toContain(`/jobs/${doc.job.id}`);
  expect(group(await search(production, "iscon mall"), "Jobs").map((h) => h.href)).toContain(`/jobs/${doc.job.id}`);
});

test("hits carry no cost fields: a purchase bill for a no-cost user has no amount, opens the vendor, isn't found by its total", async () => {
  const [bill] = group(await search(plain, doc.bill.number), "Purchase bills");
  expect(bill).toEqual({ title: doc.bill.number, detail: "SR Ambica Flex Printers · bill AF/2026/77 · 14/06/2026", href: `/vendors/${ids.vendor}` });
  expect(group(await search(plain, "₹3,481"), "Purchase bills").map((h) => h.title)).not.toContain(doc.bill.number);
  // Expenses and payments are the accountant's books, not purchase rates: their totals stay.
  expect(group(await search(plain, "₹25,000.50"), "Expenses").map((h) => h.href)).toContain(`/expenses/${doc.expense.id}`);
  // Every hit, for every user, is display text + link (+ total): nothing else rides along.
  for (const user of [owner, sales, production, plain]) {
    for (const q of [doc.bill.number, doc.job.number, "Mahalakshmi", "₹25,000.50", "Ambica"]) {
      for (const g of await search(user, q)) {
        for (const h of g.hits) expect(Object.keys(h).every((k) => ["title", "detail", "href", "amount"].includes(k)), `${user.username} ${q}`).toBe(true);
        if (!user.canViewCost) expect(g.label === "Purchase bills" && g.hits.some((h) => h.amount)).toBe(false);
      }
    }
  }
});

test("material requests, POs, GRNs, stock issues, stock adjustments, transfers and JVs by number (D63)", async () => {
  const job = doc.job.number;
  const expected: [string, string, SearchHit][] = [
    ["mr", "Material requests", { title: doc.mr.number, detail: expect.stringMatching(new RegExp(`^${job} · \\d\\d/\\d\\d/\\d{4} · Pending$`)), href: `/material-requests/${doc.mr.id}` }],
    ["po", "Purchase orders", { title: doc.po.number, detail: "SR Ambica Flex Printers · 17/06/2026 · Draft", href: `/purchase-orders/${doc.po.id}`, amount: "₹17,700.00" }],
    ["grn", "Material receive", { title: doc.grn.number, detail: `SR Ambica Flex Printers · ${doc.po.number} · 17/06/2026`, href: `/material-receive/${doc.grn.id}`, amount: "₹15,000.00" }],
    ["issue", "Stock issues", { title: doc.issue.number, detail: `Issue · ${job} · 17/06/2026`, href: `/issue-to-job/${doc.issue.id}` }],
    ["adjustment", "Stock adjustments", { title: doc.adjustment.number, detail: "SR ACP Sheet · 17/06/2026", href: "/stock-adjustments" }],
    ["transfer", "Transfers", { title: doc.transfer.number, detail: "Cash → Bank 1 · 18/06/2026", href: `/cash-bank/transfers/${doc.transfer.id}`, amount: "₹4,321.00" }],
    ["jv", "Journal vouchers", { title: doc.jv.number, detail: "SR capital brought in · 18/06/2026", href: `/journal-vouchers/${doc.jv.id}`, amount: "₹1,234.00" }],
  ];
  for (const [key, label, hit] of expected) {
    const { number } = doc[key];
    for (const q of [number, unpadded(number), unpadded(number).toLowerCase()]) expect(group(await search(owner, q), label)[0], `${key} ${q}`).toEqual(hit);
  }
  // By number only: their totals find nothing.
  for (const q of ["₹17,700", "₹4,321", "₹1,234"]) {
    expect(labels(await search(owner, q)).filter((l) => ["Purchase orders", "Material receive", "Transfers", "Journal vouchers"].includes(l)), q).toEqual([]);
  }
});

test("D63 per area: no-cost users get no PO / GRN totals (the vendor instead); production gets requests and issues only; sales none", async () => {
  expect(group(await search(plain, doc.po.number), "Purchase orders")[0]).toEqual({
    title: doc.po.number, detail: "SR Ambica Flex Printers · 17/06/2026 · Draft", href: `/vendors/${ids.vendor}`,
  });
  expect(group(await search(plain, doc.grn.number), "Material receive")[0]).toEqual({
    title: doc.grn.number, detail: `SR Ambica Flex Printers · ${doc.po.number} · 17/06/2026`, href: `/vendors/${ids.vendor}`,
  });
  // The accountant only requests stock adjustments, but sees their list (A§8): found, without a value.
  expect(group(await search(plain, doc.adjustment.number), "Stock adjustments")[0].href).toBe("/stock-adjustments");
  expect(group(await search(plain, doc.transfer.number), "Transfers")[0].amount).toBe("₹4,321.00");
  expect(labels(await search(production, doc.mr.number))).toEqual(["Material requests"]);
  expect(labels(await search(production, doc.issue.number))).toEqual(["Stock issues"]);
  for (const key of ["po", "grn", "adjustment", "transfer", "jv"]) expect(await search(production, doc[key].number), key).toEqual([]);
  for (const key of ["mr", "po", "grn", "issue", "adjustment", "transfer", "jv"]) expect(await search(sales, doc[key].number), key).toEqual([]);
});
