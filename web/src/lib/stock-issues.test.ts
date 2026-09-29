import { and, asc, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts, expenseCategories, journalEntries, journalLines, stockMoves } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { SENT_FOR_APPROVAL } from "@/lib/approvals";
import { createCustomer } from "@/lib/customers";
import { addDays, formatDate, todayIST } from "@/lib/dates";
import { cancelJob, createJob } from "@/lib/jobs";
import { ledger } from "@/lib/ledger";
import type { Role, SessionUser } from "@/lib/permissions";
import { createPurchaseBill } from "@/lib/purchase-bills";
import { saveBooks } from "@/lib/settings";
import { createItem, createStockAdjustment, getItem } from "@/lib/stock";
import {
  cancelStockIssue,
  createStockIssue,
  getStockIssue,
  issueFormOptions,
  listStockIssues,
  returnableItems,
  type IssueInput,
} from "@/lib/stock-issues";
import { createUser } from "@/lib/users";
import { createVendor } from "@/lib/vendors";

// T21 (S17, S11, A§3, A§9, D53): issues at the moving average (Dr materials_consumed with the job / Cr stock), refused
// beyond stock; returns at the job's own issue average, so a full return nets the job to zero; cancels; production
// works in qty only and never receives a value.

let owner: SessionUser;
let accountant: SessionUser;
let production: SessionUser;
let categoryId: string;
let vendorId: number;
let customerId: number;
const today = todayIST();

beforeAll(async () => {
  owner = await testOwner();
  const staff = async (role: Role, username: string, canViewCost: boolean) => {
    const user = { name: `SI ${username}`, username: `si.${username}`, role, canViewCost };
    return { ...user, id: await createUser(owner, { ...user, password: `${username}-pass-123` }) };
  };
  accountant = await staff("accountant", "accountant", true);
  production = await staff("production", "production", false);
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  categoryId = String((await db.select().from(expenseCategories).where(eq(expenseCategories.name, "Acrylic")))[0].id);
  vendorId = await createVendor(owner, { name: "SI Acrylic Supplier", gstin: "", stateCode: "24", mobile: "", address: "", creditDays: "", notes: "" });
  customerId = await createCustomer(owner, {
    name: "SI Customer", firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
    creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
  });
});

const newJob = async () => {
  const categoryId = String((await db.query.productCategories.findFirst())!.id);
  return createJob(owner, {
    customerId: String(customerId), date: formatDate(today), siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "",
    lines: JSON.stringify([{ lineId: "", categoryId, description: "", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate: "10000", discount: "", gst: "0" }]),
  });
};

/** An item with 3 sheets opening stock @ ₹100 and 7 bought @ ₹123.45: 10 sheets worth ₹1,164.15. */
async function stocked(name: string) {
  const id = await createItem(owner, { name, unit: "Sheet", categoryId, hsnSac: "", gstPercent: "18", openingQty: "3", openingRate: "100" });
  await createPurchaseBill(owner, {
    vendorId: String(vendorId), vendorBillNo: `${name}-1`, date: formatDate(today), roundOff: "", notes: "",
    lines: JSON.stringify([{ what: `item:${id}`, description: "", qty: "7", rate: "123.45", gst: "0", jobId: "" }]),
  });
  return id;
}

const doc = (kind: "issue" | "return", jobId: number, lines: [number, string][], date = today): IssueInput => ({
  kind,
  jobId: String(jobId),
  date: formatDate(date),
  notes: "",
  lines: JSON.stringify(lines.map(([itemId, qty]) => ({ itemId: String(itemId), qty }))),
});
const save = async (actor: SessionUser, input: IssueInput) => (await createStockIssue(actor, input)).id!;
const stockOf = async (itemId: number) => {
  const i = (await getItem(owner, itemId))!;
  return [i.qty, i.cost!.value];
};
/** The job's materials_consumed from the journal (+ = Dr). */
async function consumed(jobId: number) {
  const [mc] = await db.select().from(accounts).where(eq(accounts.systemKey, "materials_consumed"));
  return (await ledger({ account: mc.id, jobId })).closing;
}

test("an issue is valued round(qty × Σvalue ÷ Σqty) and posts Dr materials_consumed (job) / Cr stock; beyond stock is refused", async () => {
  const item = await stocked("SI acrylic 3mm");
  const jobId = await newJob();
  expect(await stockOf(item)).toEqual([10_000n, 1164_15n]);
  // 3 × ₹1,164.15 ÷ 10 = ₹349.245 → ₹349.25 (half away from zero).
  const id = await save(owner, doc("issue", jobId, [[item, "3"]]));
  const d = (await getStockIssue(owner, id))!;
  expect(d.number).toMatch(/^SI\/26-27\/\d{4}$/);
  expect(d.cost?.total).toBe(349_25n);
  const moves = await db.select().from(stockMoves).where(and(eq(stockMoves.source, "issue"), eq(stockMoves.sourceId, id)));
  expect(moves.map((m) => [m.qtyMilli, m.valuePaise, m.jobId])).toEqual([[-3_000n, -349_25n, jobId]]);
  const lines = await db
    .select({ key: accounts.systemKey, debit: journalLines.debitPaise, credit: journalLines.creditPaise, jobId: journalLines.jobId })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journalEntries.docType, "stock_issues"), eq(journalEntries.docId, id)))
    .orderBy(asc(journalLines.id));
  expect(lines).toEqual([
    { key: "materials_consumed", debit: 349_25n, credit: 0n, jobId },
    { key: "stock", debit: 0n, credit: 349_25n, jobId: null },
  ]);
  expect(await consumed(jobId)).toBe(349_25n);
  expect(await stockOf(item)).toEqual([7_000n, 814_90n]);

  await expect(save(owner, doc("issue", jobId, [[item, "7.5"]]))).rejects.toThrow("Line 1: Only 7 Sheet of SI acrylic 3mm in stock");
  expect(await stockOf(item)).toEqual([7_000n, 814_90n]);
  await expect(save(owner, doc("issue", jobId, [[item, "1"], [item, "1"]]))).rejects.toThrow("Put each item on one line only.");
  const cancelled = await newJob();
  await cancelJob(owner, cancelled);
  await expect(save(owner, doc("issue", cancelled, [[item, "1"]]))).rejects.toThrow("is cancelled");
});

test("a return is valued at the job's own issue average; returning it all puts the stock back and nets the job to zero", async () => {
  const item = await stocked("SI acrylic 5mm");
  const jobId = await newJob();
  await save(owner, doc("issue", jobId, [[item, "3"]])); // ₹349.25 (see above)
  // Another job's issue moves the stock average, not this job's.
  const other = await newJob();
  await save(owner, doc("issue", other, [[item, "2"]]));
  await expect(save(owner, doc("return", jobId, [[item, "3.5"]]))).rejects.toThrow("only 3 Sheet of SI acrylic 5mm is with job");

  // 1 back: ₹349.25 ÷ 3 = ₹116.4166… → ₹116.42; the last 2 take exactly what is left, ₹232.83.
  const first = await save(owner, doc("return", jobId, [[item, "1"]]));
  expect((await getStockIssue(owner, first))!).toMatchObject({ kind: "return", cost: { total: 116_42n } });
  expect(await returnableItems(jobId)).toEqual([{ id: item, name: "SI acrylic 5mm", unit: "Sheet", qty: 2_000n }]);
  const last = await save(accountant, doc("return", jobId, [[item, "2"]]));
  expect((await getStockIssue(owner, last))!).toMatchObject({ cost: { total: 232_83n } });
  expect(await consumed(jobId)).toBe(0n);
  expect(await returnableItems(jobId)).toEqual([]);
  await expect(save(owner, doc("return", jobId, [[item, "1"]]))).rejects.toThrow("isn't with job");
  // All that is gone is the other job's 2: 8 sheets, ₹1,164.15 − its ₹232.83.
  expect(await stockOf(item)).toEqual([8_000n, 931_32n]);
  expect((await listStockIssues(owner, jobId)).map((r) => [r.kind, "cost" in r && r.cost.value])).toEqual([
    ["return", 232_83n],
    ["return", 116_42n],
    ["issue", 349_25n],
  ]);
});

test("cancel: mirror moves + reversal on its date; an issue with a later return, or a return whose stock has gone out since, can't be cancelled", async () => {
  const item = await stocked("SI ACP");
  const jobId = await newJob();
  const issue = await save(owner, doc("issue", jobId, [[item, "4"]]));
  const back = await save(owner, doc("return", jobId, [[item, "1"]]));
  await expect(cancelStockIssue(owner, issue, "")).rejects.toThrow("came back from this job after this issue: cancel that return first.");
  await expect(cancelStockIssue(production, back, "")).rejects.toThrow("Not allowed");
  expect(await cancelStockIssue(accountant, back, "Wrong qty")).toEqual({ message: expect.stringMatching(/^Cancelled SI\//) });
  expect((await getStockIssue(owner, back))!.status).toBe("cancelled");
  expect((await cancelStockIssue(owner, issue, "")).message).toMatch(/^Cancelled SI\//);
  expect(await consumed(jobId)).toBe(0n);
  expect(await stockOf(item)).toEqual([10_000n, 1164_15n]);
  const entries = await db.select().from(journalEntries).where(and(eq(journalEntries.docType, "stock_issues"), eq(journalEntries.docId, issue)));
  expect(entries.map((e) => e.date)).toEqual([today, today]);
  await expect(cancelStockIssue(owner, issue, "")).rejects.toThrow("already cancelled");

  // A return whose stock went out again afterwards stays (D52): fix with an adjustment.
  await save(owner, doc("issue", jobId, [[item, "2"]]));
  const returned = await save(owner, doc("return", jobId, [[item, "2"]]));
  await createStockAdjustment(owner, { itemId: String(item), date: formatDate(today), qty: "-1", rate: "", reason: "Broken" });
  await expect(cancelStockIssue(owner, returned, "")).rejects.toThrow("has been used or issued since this return was entered");
});

test("production issues and returns in qty only: no values in anything it loads; a backdated issue waits for the owner", async () => {
  const item = await stocked("SI LED module");
  const jobId = await newJob();
  const id = await save(production, doc("issue", jobId, [[item, "2"]]));
  await save(production, doc("return", jobId, [[item, "1"]]));
  const seen = [
    await listStockIssues(production),
    await listStockIssues(production, jobId),
    await getStockIssue(production, id),
    await issueFormOptions(production),
    await returnableItems(jobId),
  ];
  const keys = (v: unknown): string[] =>
    Array.isArray(v) ? v.flatMap(keys) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : [];
  for (const data of seen) {
    for (const k of ["cost", "value", "valuePaise", "average", "rate", "total"]) expect(keys(data)).not.toContain(k);
  }
  expect((await getStockIssue(production, id))!.lines).toEqual([{ issueId: id, itemId: item, position: 1, name: "SI LED module", unit: "Sheet", qty: 2_000n }]);
  // The owner sees the values.
  expect(await getStockIssue(owner, id)).toMatchObject({ cost: { total: expect.any(BigInt) } });

  // Backdate days not set = anything before today needs the owner (D39, A§7).
  expect(await createStockIssue(production, doc("issue", jobId, [[item, "1"]], addDays(today, -2)))).toEqual({ id: null, message: SENT_FOR_APPROVAL });
  expect((await getItem(owner, item))!.qty).toBe(9_000n);
});
