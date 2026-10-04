import { mkdir, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { and, count, eq, inArray, like, sql } from "drizzle-orm";
import { Workbook } from "exceljs";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts, customers, journalEntries, journalLines, openingBills, settings, stockItems, vendors } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { createAdjustment, getAdjustment } from "@/lib/adjustments";
import { customerOpeningBills, openInvoices } from "@/lib/allocations";
import { exportAll } from "@/lib/data-export";
import { addDays } from "@/lib/dates";
import { gstinCheckChar } from "@/lib/gstin";
import { excelQty, excelRupees, parseMoney, parseQty } from "@/lib/num";
import { cancelOpeningBill, importOpeningData, openingWorkbook, SHEETS, type ImportResult } from "@/lib/opening-import";
import { outstanding } from "@/lib/outstanding";
import type { SessionUser } from "@/lib/permissions";
import { createReceipt } from "@/lib/receipts";
import { pendingPaymentReport } from "@/lib/reports-sales";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";
import { createVendorPayment, openBills } from "@/lib/vendor-payments";

// T43 (D40, D67): a filled template imports (checked first, nothing saved), the full export gives it back, the books
// balance with opening_equity = the net of all openings, a receipt / vendor payment pays an opening bill and aging
// shows the rest by its bill date, a bad file imports nothing and lists every error, and a second import adds
// nothing. Names start "OI " (no other test file uses them); money accounts: Bank 2 only (others assert Cash / Petty).

let owner: SessionUser;
let accountant: SessionUser;
const withCheck = (first14: string) => first14 + gstinCheckChar(first14);
const GST_A = withCheck("24AAAPO1001Q1Z");
const GST_V = withCheck("24AAAPO2002Q1Z");
const BAD_GSTIN = "24AAAPO3003Q1Z" + (gstinCheckChar("24AAAPO3003Q1Z") === "0" ? "1" : "0");

/** The filled sample (the order of each sheet's columns, as text). */
const SAMPLE = {
  customers: [
    ["OI Shree Ganesh Signs", "OI Ganesh Group", "97000 11001", GST_A, "", "ganesh@example.com", "Naroda, Ahmedabad", "Site 4, Naroda", "50,000", "15", "Yes", "1,500.50"],
    ["OI Jay Ambe Traders", "", "97000 11002", "", "Maharashtra", "", "", "", "", "", "", ""],
    ["OI Advance Party", "", "+91 97000 11003", "", "24", "", "", "", "", "", "No", "-2,000"],
  ],
  customerBills: [
    ["97000 11001", "A-101", "10/02/2026", "25/02/2026", "12,000"],
    [GST_A, "A-102", "15/03/2026", "", "8,000.75"],
    ["9700011002", "B-7", "01/04/2026", "", "5000"],
  ],
  vendors: [
    ["OI Shree Acrylic Supply", GST_V, "", "98250 22001", "Odhav", "30", "750"],
    ["OI Mumbai LED", "", "27", "", "", "", "-300"],
  ],
  vendorBills: [
    [GST_V, "SA/889", "20/03/2026", "19/04/2026", "9,440"],
    ["oi mumbai led", "ML-55", "31/03/2026", "", "2,500"],
  ],
  items: [
    ["OI Acrylic 3mm", "Sheet", "Acrylic", "3920", "18", "25", "1,250"],
    ["OI Flex roll 10ft", "", "flex", "", "", "", ""],
  ],
  money: [["Bank 2", "1,00,000.50"]],
};
const START = "2026-04-01";
/** Each party's opening balance = Σ its opening bills + its lump (D67). */
const OPENING: Record<string, bigint> = {
  "OI Shree Ganesh Signs": 12_000_00n + 8_000_75n + 1_500_50n,
  "OI Jay Ambe Traders": 5_000_00n,
  "OI Advance Party": -2_000_00n,
  "OI Shree Acrylic Supply": 9_440_00n + 750_00n,
  "OI Mumbai LED": 2_500_00n - 300_00n,
};

const result = (r: ImportResult) => ({ problems: r.problems, duplicates: r.duplicates });
const counted = async () => ({
  customers: (await db.select({ n: count() }).from(customers))[0].n,
  vendors: (await db.select({ n: count() }).from(vendors))[0].n,
  items: (await db.select({ n: count() }).from(stockItems))[0].n,
  bills: (await db.select({ n: count() }).from(openingBills))[0].n,
  entries: (await db.select({ n: count() }).from(journalEntries))[0].n,
});

beforeAll(async () => {
  owner = await testOwner();
  const u = { name: "oi.acct", username: "oi.acct", role: "accountant" as const, canViewCost: true };
  accountant = { ...u, id: await createUser(owner, { ...u, password: "oi-acct-pass-1" }) };
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
});

test("the template: a Read me, then the six sheets with their headers; blank + filled saved to .samples", async () => {
  const blank = await openingWorkbook();
  const book = new Workbook();
  await book.xlsx.load(blank as unknown as Parameters<typeof book.xlsx.load>[0]);
  expect(book.worksheets.map((w) => w.name)).toEqual(["Read me", "Customers", "Customer opening bills", "Vendors", "Vendor opening bills", "Stock items", "Money accounts"]);
  expect((book.getWorksheet("Customer opening bills")!.getRow(1).values as string[]).slice(1)).toEqual(["Customer mobile, GSTIN or name", "Bill no", "Bill date", "Due date", "Amount due"]);
  // Every column is explained on the Read me sheet.
  const readme = JSON.stringify(book.getWorksheet("Read me")!.getSheetValues());
  for (const def of Object.values(SHEETS)) for (const c of def.columns) expect(readme).toContain(c.header);
  await mkdir(".samples", { recursive: true });
  await writeFile(".samples/opening-template.xlsx", blank);
  await writeFile(".samples/opening-sample.xlsx", await openingWorkbook(SAMPLE));
});

test("check: the filled sample has no problems, shows the totals per sheet, and saves nothing", async () => {
  const before = await counted();
  const check = await importOpeningData(owner, await openingWorkbook(SAMPLE), false);
  expect(result(check)).toEqual({ problems: [], duplicates: [] });
  expect(check.imported).toBe(false);
  expect(check.totals).toEqual([
    { sheet: "Customers", rows: 3, amount: "-₹499.50" }, // not bill-wise: 1,500.50 − 2,000
    { sheet: "Customer opening bills", rows: 3, amount: "₹25,000.75" },
    { sheet: "Vendors", rows: 2, amount: "₹450.00" },
    { sheet: "Vendor opening bills", rows: 2, amount: "₹11,940.00" },
    { sheet: "Stock items", rows: 2, amount: "₹31,250.00" }, // 25 × ₹1,250
    { sheet: "Money accounts", rows: 1, amount: "₹1,00,000.50" },
  ]);
  expect(await counted()).toEqual(before);
});

test("import: every row in one go; a party's opening = Σ its opening bills + its lump; the books balance", async () => {
  const done = await importOpeningData(owner, await openingWorkbook(SAMPLE), true);
  expect(result(done)).toEqual({ problems: [], duplicates: [] });
  expect(done.imported).toBe(true);

  const cs = await db.select().from(customers).where(like(customers.name, "OI %"));
  const c = (name: string) => cs.find((x) => x.name === name)!;
  expect(c("OI Shree Ganesh Signs")).toMatchObject({ gstin: GST_A, stateCode: "24", creditDays: 15, isCreditCustomer: true, creditLimitPaise: 50_000_00n });
  expect(c("OI Jay Ambe Traders").stateCode).toBe("27");
  for (const x of cs) expect(x.openingBalancePaise, x.name).toBe(OPENING[x.name]);
  const vs = await db.select().from(vendors).where(like(vendors.name, "OI %"));
  for (const x of vs) expect(x.openingBalancePaise, x.name).toBe(OPENING[x.name]);
  const [{ days }] = await db.select({ days: settings.defaultCreditDays }).from(settings);
  const bills = await db.select().from(openingBills).where(inArray(openingBills.customerId, cs.map((x) => x.id)));
  expect(bills.map((b) => [b.billNo, b.billDate, b.dueDate, b.amountPaise]).sort()).toEqual([
    ["A-101", "2026-02-10", "2026-02-25", 12_000_00n],
    ["A-102", "2026-03-15", "2026-03-30", 8_000_75n], // blank due = bill date + the customer's 15 days
    ["B-7", START, addDays(START, days ?? 0), 5_000_00n], // no credit days: the Settings default
  ]);

  // Trial balance: Σ Dr = Σ Cr, and opening_equity = the net of every opening the import posted.
  const [tb] = await db.select({ dr: sql<string>`sum(${journalLines.debitPaise})`, cr: sql<string>`sum(${journalLines.creditPaise})` }).from(journalLines);
  expect(tb.dr).toBe(tb.cr);
  const [item] = await db.select().from(stockItems).where(eq(stockItems.name, "OI Acrylic 3mm"));
  const [bank2] = await db.select().from(accounts).where(eq(accounts.systemKey, "bank_2"));
  expect(bank2.openingBalancePaise).toBe(1_00_000_50n);
  const docs = [
    ...cs.map((x) => ["customers", x.id] as const),
    ...vs.map((x) => ["vendors", x.id] as const),
    ["stock_items", item.id] as const,
    ["accounts", bank2.id] as const,
  ];
  const [equity] = await db.execute<{ net: string }>(sql`
    select coalesce(sum(l.debit_paise - l.credit_paise), 0) as net from journal_lines l
    join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
    where a.system_key = 'opening_equity' and (e.doc_type, e.doc_id) in (${sql.join(docs.map(([t, id]) => sql`(${t}, ${id})`), sql`, `)})`);
  // AR 24,501.25 + stock 31,250 + bank 1,00,000.50 − AP 12,390 = 1,43,361.75 on the Cr side.
  expect(BigInt(equity.net)).toBe(-(24_501_25n + 31_250_00n + 1_00_000_50n - 12_390_00n));
});

test("round trip: the full export (T36) gives back what the file said", async () => {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk));
  await exportAll(out);
  const book = new Workbook();
  await book.xlsx.load(Buffer.concat(chunks) as unknown as Parameters<typeof book.xlsx.load>[0]);
  const sheet = (name: string) => {
    const ws = book.getWorksheet(name)!;
    const header = (ws.getRow(1).values as string[]).slice(1);
    return Array.from({ length: ws.rowCount - 1 }, (_, i) => {
      const values = (ws.getRow(i + 2).values as unknown[]).slice(1);
      return Object.fromEntries(header.map((h, j) => [h, values[j] ?? null]));
    });
  };
  const rupees = (text: string) => (text ? excelRupees(parseMoney(text.replace(/,/g, ""))) : 0);
  const day = (text: string) => new Date(`${text.split("/").reverse().join("-")}T00:00:00Z`);

  const cs = sheet("customers");
  for (const [name, firm, mobile, gstin, , email, billing, site, limit, days, credit] of SAMPLE.customers) {
    expect(cs.find((r) => r.name === name)).toMatchObject({
      firm_name: firm || null, mobile, gstin: gstin || null, email: email || null, billing_address: billing || null, site_address: site || null,
      credit_limit_rupees: limit ? rupees(limit) : null, is_credit_customer: credit === "Yes", opening_balance_rupees: excelRupees(OPENING[name]),
      ...(days ? { credit_days: Number(days) } : {}),
    });
  }
  const ob = sheet("opening_bills");
  for (const [, billNo, billDate, dueDate, amount] of [...SAMPLE.customerBills, ...SAMPLE.vendorBills]) {
    const row = ob.find((r) => r.bill_no === billNo)!;
    expect(row).toMatchObject({ bill_date: day(billDate), amount_rupees: rupees(amount), ...(dueDate ? { due_date: day(dueDate) } : {}) });
  }
  const vs = sheet("vendors");
  for (const [name, gstin, , mobile, address, days] of SAMPLE.vendors) {
    expect(vs.find((r) => r.name === name)).toMatchObject({
      gstin: gstin || null, mobile: mobile || null, address: address || null, opening_balance_rupees: excelRupees(OPENING[name]), ...(days ? { credit_days: Number(days) } : {}),
    });
  }
  const items = sheet("stock_items");
  for (const [name, unit, , hsn, gst, qty, rate] of SAMPLE.items) {
    expect(items.find((r) => r.name === name)).toMatchObject({
      unit: unit || "Nos", hsn_sac: hsn || null, gst_bp: gst ? Number(gst) * 100 : null, opening_qty: qty ? excelQty(parseQty(qty)) : 0, opening_rate_rupees: rupees(rate),
    });
  }
  expect(sheet("accounts").find((r) => r.name === "Bank 2")).toMatchObject({ opening_balance_rupees: rupees(SAMPLE.money[0][1]) });
});

test("a receipt allocated to an opening bill reduces it; outstanding ages the rest by its bill date; vendors likewise", async () => {
  const [ganesh] = await db.select().from(customers).where(eq(customers.name, "OI Shree Ganesh Signs"));
  const open = await openInvoices(db, ganesh.id);
  expect(open.map((o) => [o.target, o.number, o.open])).toEqual([
    ["opening_bill", "Opening A-101", 12_000_00n],
    ["opening_bill", "Opening A-102", 8_000_75n],
  ]);
  const [cash] = await db.select().from(accounts).where(eq(accounts.systemKey, "cash"));
  await createReceipt(owner, {
    customerId: String(ganesh.id), date: "02/04/2026", amount: "5,000", mode: "cash", moneyAccountId: String(cash.id), reference: "", chequeNo: "", chequeDate: "",
    receivedBy: "", notes: "", allocations: JSON.stringify([{ target: "opening_bill", id: String(open[0].id), amount: "5,000" }]),
  });
  expect((await openInvoices(db, ganesh.id)).map((o) => o.open)).toEqual([7_000_00n, 8_000_75n]);

  // As of 30/04/2026: A-101 is 79 days old (60+), A-102 46 days (31–60), both past due; what isn't bill-wise
  // (the ₹1,500.50 lump) is the "Opening / on account" line, and the lines add up to AR.
  const mine = (await outstanding("2026-04-30")).customers.find((c) => c.id === ganesh.id)!;
  expect(mine.docs.map((d) => [d.number, d.bucket, d.due, d.open])).toEqual([
    ["Opening A-101", "d60", "overdue", 7_000_00n],
    ["Opening A-102", "d31_60", "overdue", 8_000_75n], // due 30/03
  ]);
  expect(mine.totals).toMatchObject({ total: 16_501_25n, onAccount: 1_500_50n, overdue: 15_000_75n });
  expect(mine.totals.aging).toMatchObject({ d60: 7_000_00n, d31_60: 8_000_75n });

  // A vendor payment on an opening bill; pending payment lists the rest by its bill date.
  const [supplier] = await db.select().from(vendors).where(eq(vendors.name, "OI Shree Acrylic Supply"));
  const [bill] = await openBills(db, supplier.id);
  expect([bill.target, bill.number, bill.open]).toEqual(["opening_bill", "Opening SA/889", 9_440_00n]);
  await createVendorPayment(owner, {
    vendorId: String(supplier.id), date: "03/04/2026", amount: "4,000", mode: "cash", moneyAccountId: String(cash.id), reference: "", chequeNo: "", chequeDate: "",
    notes: "", allocations: JSON.stringify([{ target: "opening_bill", id: String(bill.id), amount: "4,000" }]),
  });
  expect((await openBills(db, supplier.id))[0].open).toBe(5_440_00n);
  const pending = (await pendingPaymentReport(owner, { vendor: String(supplier.id) }, new Date("2026-04-30T06:00:00Z")))!.report.tables[0].rows;
  expect(pending.map((r) => [r.number, r.date, r.age, r.open])).toEqual([["Opening SA/889", "2026-03-20", 41n, 5_440_00n]]);
});

test("importing the same file again adds nothing: every row is already in the CRM", async () => {
  const before = await counted();
  const again = await importOpeningData(owner, await openingWorkbook(SAMPLE), true);
  expect(again.imported).toBe(false);
  expect(again.problems).toEqual([]);
  expect(again.duplicates.map((d) => d.sheet)).toEqual([
    "Customers", "Customer opening bills", "Customer opening bills", "Customers", "Customer opening bills", "Customers",
    "Vendors", "Vendor opening bills", "Vendors", "Vendor opening bills", "Stock items", "Stock items", "Money accounts",
  ]);
  expect(await counted()).toEqual(before);
});

const blankCustomer = (name: string, mobile = "", lump = "") => [name, "", mobile, "", "", "", "", "", "", "", "", lump];
const blankVendor = (name: string, lump = "") => [name, "", "", "", "", "", lump];
const balance = async (key: "ar" | "ap", party: { customerId: number } | { vendorId: number }) => {
  const [r] = await db.execute<{ net: string }>(sql`
    select coalesce(sum(l.debit_paise - l.credit_paise), 0) as net from journal_lines l join accounts a on a.id = l.account_id
    where a.system_key = ${key} and ${"customerId" in party ? sql`l.customer_id = ${party.customerId}` : sql`l.vendor_id = ${party.vendorId}`}`);
  return key === "ar" ? BigInt(r.net) : -BigInt(r.net);
};
const customerNamed = async (name: string) => (await db.select().from(customers).where(eq(customers.name, name)))[0];
const vendorNamed = async (name: string) => (await db.select().from(vendors).where(eq(vendors.name, name)))[0];

test("D68: a customer with neither mobile nor GSTIN is keyed by its name; masters first, dues later (by key)", async () => {
  const masters = { customers: [blankCustomer("OI Name Only"), blankCustomer("OI Later Dues", "97000 44001")], vendors: [blankVendor("OI Later Vendor")] };
  expect(result(await importOpeningData(owner, await openingWorkbook(masters), true))).toEqual({ problems: [], duplicates: [] });
  // Masters already in the CRM still block — the name (trimmed, any case) for the one with neither.
  const again = await importOpeningData(owner, await openingWorkbook({ ...masters, customers: [blankCustomer("  oi NAME only "), masters.customers[1]] }), true);
  expect(again.duplicates.map((d) => [d.sheet, d.row])).toEqual([["Customers", 2], ["Customers", 3], ["Vendors", 2]]);

  // Dues later: bills naming parties already in the CRM, and a lump on a row of a party with no opening yet.
  const dues = {
    customers: [blankCustomer("OI Later Dues (other columns ignored)", "+91 97000 44001", "1,000")],
    customerBills: [["oi name only", "N-1", "01/03/2026", "", "700"], ["9700044001", "L-1", "01/03/2026", "", "300"]],
    vendorBills: [["OI LATER VENDOR", "V-1", "01/03/2026", "", "450"]],
  };
  expect(result(await importOpeningData(owner, await openingWorkbook(dues), true))).toEqual({ problems: [], duplicates: [] });
  const nameOnly = await customerNamed("OI Name Only");
  expect(nameOnly).toMatchObject({ mobile: null, gstin: null, openingBalancePaise: 700_00n });
  expect(await balance("ar", { customerId: nameOnly.id })).toBe(700_00n);
  const later = await customerNamed("OI Later Dues");
  expect(later.openingBalancePaise).toBe(1_300_00n); // the lump + L-1
  expect(await balance("ar", { customerId: later.id })).toBe(1_300_00n);
  const vendor = await vendorNamed("OI Later Vendor");
  expect(vendor.openingBalancePaise).toBe(450_00n);
  expect(await balance("ap", { vendorId: vendor.id })).toBe(450_00n);

  // Now they have openings: the same dues are refused and nothing changes.
  const before = await counted();
  const twice = await importOpeningData(owner, await openingWorkbook(dues), true);
  expect(twice.duplicates.map((d) => [d.sheet, d.row])).toEqual([["Customers", 2], ["Customer opening bills", 3], ["Customer opening bills", 2], ["Vendor opening bills", 2]]);
  expect(await counted()).toEqual(before);
});

test("D68: the owner cancels an unallocated opening bill — the opening is reposted without it; an allocated one stays", async () => {
  const nameOnly = await customerNamed("OI Name Only");
  const [n1] = await db.select().from(openingBills).where(eq(openingBills.customerId, nameOnly.id));
  await expect(cancelOpeningBill(accountant, n1.id)).rejects.toThrow("Not allowed");
  expect(await cancelOpeningBill(owner, n1.id)).toBe(`/customers/${nameOnly.id}`);
  expect((await customerNamed("OI Name Only")).openingBalancePaise).toBe(0n);
  expect(await balance("ar", { customerId: nameOnly.id })).toBe(0n);
  expect((await customerOpeningBills(nameOnly.id)).map((b) => [b.billNo, b.payment, b.open])).toEqual([["N-1", "Cancelled", 0n]]);
  expect(await openInvoices(db, nameOnly.id)).toEqual([]);
  await expect(cancelOpeningBill(owner, n1.id)).rejects.toThrow("already cancelled");
  const audited = await db.execute<{ n: string }>(sql`select count(*) as n from audit_log where table_name = 'opening_bills' and row_id = ${String(n1.id)} and action = 'update' and user_id = ${owner.id}`);
  expect(Number(audited[0].n)).toBe(1);

  // D70: the cancelled bill's number is free again — the corrected bill comes back under its real number, once.
  const fixed = { customerBills: [["OI Name Only", "n-1", "01/03/2026", "", "750"]] };
  expect(result(await importOpeningData(owner, await openingWorkbook(fixed), true))).toEqual({ problems: [], duplicates: [] });
  expect((await customerNamed("OI Name Only")).openingBalancePaise).toBe(750_00n);
  expect(await balance("ar", { customerId: nameOnly.id })).toBe(750_00n);
  expect((await importOpeningData(owner, await openingWorkbook(fixed), true)).duplicates.map((d) => d.message)).toEqual(["Already in the CRM: OI Name Only's bill n-1."]);
  const twin = db.insert(openingBills).values({ customerId: nameOnly.id, billNo: "N-1", billDate: "2026-03-01", dueDate: "2026-03-01", amountPaise: 1n, createdBy: owner.id });
  await expect(twin).rejects.toMatchObject({ cause: { code: "23505", constraint_name: "opening_bills_customer_bill_no" } });

  const vendor = await vendorNamed("OI Later Vendor");
  const [v1] = await db.select().from(openingBills).where(eq(openingBills.vendorId, vendor.id));
  expect(await cancelOpeningBill(owner, v1.id)).toBe(`/vendors/${vendor.id}`);
  expect((await vendorNamed("OI Later Vendor")).openingBalancePaise).toBe(0n);
  expect(await balance("ap", { vendorId: vendor.id })).toBe(0n);
  expect(await openBills(db, vendor.id)).toEqual([]);

  // A-101 has ₹5,000 of a receipt on it (above): it can't be cancelled.
  const ganesh = await customerNamed("OI Shree Ganesh Signs");
  const [a101] = await db.select().from(openingBills).where(and(eq(openingBills.customerId, ganesh.id), eq(openingBills.billNo, "A-101")));
  await expect(cancelOpeningBill(owner, a101.id)).rejects.toThrow("Opening A-101 has ₹5,000.00 allocated");
});

test("D68: a customer write-off settles an opening bill (old uncollectable dues)", async () => {
  const ganesh = await customerNamed("OI Shree Ganesh Signs");
  const a102 = (await openInvoices(db, ganesh.id)).find((o) => o.number === "Opening A-102")!;
  const { id } = await createAdjustment(owner, {
    kind: "write_off", date: "05/04/2026", narration: "Old dues, not recoverable", lines: "[]", customerId: String(ganesh.id), amount: "8,000.75", moneyAccountId: "",
    allocations: JSON.stringify([{ target: "opening_bill", id: String(a102.id), amount: "8,000.75" }]),
  });
  expect((await openInvoices(db, ganesh.id)).map((o) => o.number)).toEqual(["Opening A-101"]);
  expect((await getAdjustment(id!))!.allocated.map((a) => [a.what, a.number, a.amount])).toEqual([["Opening bill", "Opening A-102", 8_000_75n]]);
  await expect(cancelOpeningBill(owner, a102.id)).rejects.toThrow("allocated");
});

test("a file with bad rows imports nothing and lists every error", async () => {
  const before = await counted();
  const bad = await openingWorkbook({
    customers: [
      ["", "", "97000 33001", "", "", "", "", "", "", "", "", ""], // 2: no name
      ["OI Bad GSTIN", "", "", BAD_GSTIN, "", "", "", "", "", "", "", ""], // 3: check digit
      ["OI Bad Mobile", "", "call me", "", "", "", "", "", "", "", "", ""], // 4: mobile
      ["OI Bad Amount", "", "97000 33004", "", "Atlantis", "", "", "", "", "", "Maybe", "12.345"], // 5: state, Yes/No, decimals
      ["OI No Key", "", "", "", "", "", "", "", "", "", "", "1.234"], // 6: 3 decimals (no mobile / GSTIN is fine: keyed by name, D68)
    ],
    customerBills: [
      ["97000 99999", "X-1", "01/03/2026", "", "100"], // 2: unknown customer
      ["97000 33004", "X-2", "05/04/2026", "", "100"], // 3: after the books start date
      ["97000 33004", "X-3", "31/02/2026", "", "0"], // 4: no such date, amount 0
      ["97000 33004", "X-4", "01/03/2026", "28/02/2026", "100"], // 5: due before the bill
      ["97000 88888", "X-5", "01/03/2026", "", "0"], // 6: unknown customer, amount 0
    ],
    vendors: [
      ["OI Twin Vendor", "", "", "", "", "", ""],
      ["oi twin vendor", "", "", "", "", "", ""], // 3: same name
    ],
    items: [["OI Wood plank", "", "Wood", "", "", "-1", ""]], // 2: unknown category, negative qty
    money: [["Bank 9", "100"]], // 2: unknown account
  });
  // A formula is refused, never evaluated.
  const book = new Workbook();
  await book.xlsx.load(bad as unknown as Parameters<typeof book.xlsx.load>[0]);
  book.getWorksheet("Vendors")!.getRow(4).values = ["OI Formula Vendor", "", "", "", "", "", { formula: "100*2", result: 200 }];
  const file = Buffer.from(await book.xlsx.writeBuffer());

  const r = await importOpeningData(owner, file, true);
  expect(r.imported).toBe(false);
  // The formula stops the file before any row is checked; without it, every row's problems are listed.
  expect(r.problems).toEqual([{ sheet: "Vendors", row: 4, column: "Opening balance not bill-wise", message: "Holds a formula: type the value instead." }]);
  book.getWorksheet("Vendors")!.spliceRows(4, 1);
  const r2 = await importOpeningData(owner, Buffer.from(await book.xlsx.writeBuffer()), true);
  const at = r2.problems.map((p) => `${p.sheet}:${p.row}:${p.column}`);
  expect(at).toEqual(
    expect.arrayContaining([
      "Customers:2:Name",
      "Customers:3:GSTIN",
      "Customers:4:Mobile",
      "Customers:5:State",
      "Customers:5:Credit customer",
      "Customers:5:Opening balance not bill-wise",
      "Customers:6:Opening balance not bill-wise",
      "Customer opening bills:2:Customer mobile, GSTIN or name",
      "Customer opening bills:6:Customer mobile, GSTIN or name",
      "Customer opening bills:3:Bill date",
      "Customer opening bills:4:Bill date",
      "Customer opening bills:4:Amount due",
      "Customer opening bills:5:Due date",
      "Customer opening bills:6:Amount due",
      "Vendors:3:null",
      "Stock items:2:Category",
      "Stock items:2:Opening qty",
      "Money accounts:2:Account",
    ]),
  );
  expect(r2.problems).toHaveLength(18);
  expect(r2.imported).toBe(false);
  expect(await counted()).toEqual(before);
  expect(await db.select().from(customers).where(like(customers.name, "OI Bad%"))).toEqual([]);
});

test("the books start date can't move before the latest opening bill", async () => {
  await expect(saveBooks(owner, { booksStartDate: "31/03/2026", accounts: [] })).rejects.toThrow("Opening bills are dated up to 01/04/2026");
});

test("owner only; an .xlsx under 2 MB only", async () => {
  await expect(importOpeningData(accountant, await openingWorkbook(), false)).rejects.toThrow("Not allowed");
  await expect(importOpeningData(owner, new TextEncoder().encode("name,mobile\nA,1"), false)).rejects.toThrow("isn't an Excel .xlsx file");
  await expect(importOpeningData(owner, new Uint8Array(2 * 1024 * 1024 + 1), false)).rejects.toThrow("over 2 MB");
  // An empty template is fine: nothing to import.
  expect((await importOpeningData(owner, await openingWorkbook(), false)).problems).toEqual([]);
});
