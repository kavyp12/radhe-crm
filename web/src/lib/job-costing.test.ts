import { eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts, expenseCategories, jobCostEntries } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { createCustomer } from "@/lib/customers";
import { formatDate, todayIST } from "@/lib/dates";
import { cancelExpense, createExpense } from "@/lib/expenses";
import { createInvoiceFromJobs, issueInvoice } from "@/lib/invoices";
import { addJobCost, deactivateJobCost, jobCosting } from "@/lib/job-costing";
import { createJob } from "@/lib/jobs";
import type { Role, SessionUser } from "@/lib/permissions";
import { createPurchaseBill } from "@/lib/purchase-bills";
import { createReceipt } from "@/lib/receipts";
import { saveBooks } from "@/lib/settings";
import { createItem } from "@/lib/stock";
import { createStockIssue } from "@/lib/stock-issues";
import { createUser } from "@/lib/users";
import { createVendor } from "@/lib/vendors";

// T27 (S3, S11, A§10, D57): the job P&L from the journal + manual entries reproduces the S11 example exactly; a
// cancelled expense drops out; sales and production get no cost fields.

let owner: SessionUser;
const staff: Partial<Record<Role, SessionUser>> = {};
const today = todayIST();
const category = async (name: string) => String((await db.select().from(expenseCategories).where(eq(expenseCategories.name, name)))[0].id);

beforeAll(async () => {
  owner = await testOwner();
  for (const [role, canViewCost] of [["accountant", true], ["sales", false], ["production", false]] as [Role, boolean][]) {
    const user = { name: `JC ${role}`, username: `jc.${role}`, role, canViewCost };
    staff[role] = { ...user, id: await createUser(owner, { ...user, password: `${role}-pass-123` }) };
  }
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
});

test("S11: sale ₹1,00,000 − cost ₹62,000 (material 42k, labour 8k, printing 4k, installation 6k, transport 2k) = ₹38,000, 38%", async () => {
  const [cash] = await db.select().from(accounts).where(eq(accounts.systemKey, "cash"));
  const customerId = await createCustomer(owner, {
    name: "JC Customer", firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
    creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
  });
  const vendorId = await createVendor(owner, { name: "JC Installer", gstin: "", stateCode: "24", mobile: "", address: "", creditDays: "", notes: "" });
  const productCategory = String((await db.query.productCategories.findFirst())!.id);
  const job = await createJob(owner, {
    customerId: String(customerId), date: formatDate(today), siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "",
    lines: JSON.stringify([{ lineId: "", categoryId: productCategory, description: "Shop board", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate: "1,00,000", discount: "", gst: "18" }]),
  });
  const money = { date: formatDate(today), mode: "cash", moneyAccountId: String(cash.id), reference: "", chequeNo: "", chequeDate: "", notes: "" };
  await createReceipt(owner, { ...money, customerId: String(customerId), amount: "20,000", receivedBy: "", allocations: JSON.stringify([{ target: "job", id: String(job), amount: "20,000" }]) });

  // Material ₹42,000: 42 sheets @ ₹1,000 issued to the job (Dr materials_consumed).
  const item = await createItem(owner, { name: "JC Acrylic Sheet", unit: "Sheet", categoryId: await category("Acrylic"), hsnSac: "", gstPercent: "18", openingQty: "42", openingRate: "1000" });
  await createStockIssue(owner, { kind: "issue", jobId: String(job), date: formatDate(today), notes: "", lines: JSON.stringify([{ itemId: String(item), qty: "42" }]) });
  // Labour ₹8,000 and transport ₹2,000: job-tagged expenses.
  const expense = async (name: string, amount: string) =>
    (await createExpense(owner, { ...money, amount, categoryId: await category(name), vendorId: "", jobId: String(job) })).id!;
  await expense("Labour", "8,000");
  await expense("Transport", "2,000");
  // Installation ₹6,000: a job-tagged expense line on a purchase bill.
  await createPurchaseBill(owner, {
    vendorId: String(vendorId), vendorBillNo: "JC-INST-1", date: formatDate(today), roundOff: "", notes: "",
    lines: JSON.stringify([{ what: `cat:${await category("Installation")}`, description: "Fixing", qty: "1", rate: "6,000", gst: "0", jobId: String(job) }]),
  });
  // Printing ₹4,000: a manual entry (never posted).
  await addJobCost(owner, job, { bucket: "printing", date: formatDate(today), amount: "4,000", note: "In-house flex print" });

  // Before the invoice: no sale yet; balance = job total ₹1,18,000 − advance ₹20,000.
  const before = (await jobCosting(owner, job))!;
  expect([before.sale, before.totalCost, before.marginBp, before.advance, before.balance.amount]).toEqual([0n, 62000_00n, null, 20000_00n, 98000_00n]);
  // D58 estimate until invoiced: the job's value excl. GST − costs so far.
  expect(before.expected).toEqual({ sale: 100000_00n, profit: 38000_00n });

  const invoice = await createInvoiceFromJobs(owner, [job], "tax");
  await issueInvoice(owner, invoice);
  const card = (await jobCosting(owner, job))!;
  expect(card.sale).toBe(100000_00n); // taxable value, GST excluded
  expect(card.expected).toBeNull();
  expect(card.cost).toEqual({ material: 42000_00n, labour: 8000_00n, installation: 6000_00n, transport: 2000_00n, printing: 4000_00n, other: 0n });
  expect([card.totalCost, card.profit, card.marginBp]).toEqual([62000_00n, 38000_00n, 3800]);
  // The advance moved onto the invoice at Issue and still counts; the balance is the invoice's open amount.
  expect([card.advance, card.balance.amount, card.balance.invoice?.shared]).toEqual([20000_00n, 98000_00n, false]);

  // A cancelled expense drops out (its reversal nets it); so does a deactivated manual entry.
  const extra = await expense("Labour", "500");
  expect((await jobCosting(owner, job))!.cost.labour).toBe(8500_00n);
  await cancelExpense(owner, extra, "Entered on the wrong job");
  await addJobCost(staff.accountant!, job, { bucket: "other", date: formatDate(today), amount: "300", note: "" });
  const other = (await db.select().from(jobCostEntries).where(eq(jobCostEntries.bucket, "other")))[0];
  await deactivateJobCost(owner, other.id);
  await expect(deactivateJobCost(owner, other.id)).rejects.toThrow("This cost entry is already removed.");
  const after = (await jobCosting(owner, job))!;
  expect([after.cost.labour, after.cost.other, after.totalCost, after.profit]).toEqual([8000_00n, 0n, 62000_00n, 38000_00n]);
  expect(after.entries.map((e) => [e.bucket, e.amount, e.active])).toEqual([["printing", 4000_00n, true], ["other", 300_00n, false]]);

  // Never deleted (hard rule 3).
  await expect(db.delete(jobCostEntries).where(eq(jobCostEntries.id, other.id))).rejects.toThrow();

  // Sales and production get no cost fields at all, and can't enter costs.
  expect(await jobCosting(staff.sales!, job)).toBeUndefined();
  expect(await jobCosting(staff.production!, job)).toBeUndefined();
  expect(await jobCosting({ ...staff.production!, canViewCost: true }, job)).toBeUndefined(); // production never sees money
  const input = { bucket: "labour", date: formatDate(today), amount: "1", note: "" };
  await expect(addJobCost(staff.sales!, job, input)).rejects.toThrow("Not allowed");
  await expect(addJobCost({ ...staff.accountant!, canViewCost: false }, job, input)).rejects.toThrow("Not allowed");
});
