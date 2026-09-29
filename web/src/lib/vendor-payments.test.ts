import { mkdir, writeFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { GET as shareRoute } from "@/app/share/[token]/route";
import { db } from "@/db";
import { accounts, approvalRequests, expenseCategories, journalLines } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { approve, SENT_FOR_APPROVAL } from "@/lib/approvals";
import { addDays, formatDate, todayIST } from "@/lib/dates";
import { vendorStatementPdf } from "@/lib/pdf";
import type { Role, SessionUser } from "@/lib/permissions";
import { cancelPurchaseBill, createPurchaseBill, getPurchaseBill, listPurchaseBills, updatePurchaseBill, type BillInput } from "@/lib/purchase-bills";
import { saveBooks } from "@/lib/settings";
import { createVendorStatementLink, readRange, vendorLedger, withoutReversed } from "@/lib/statements";
import { createUser } from "@/lib/users";
import {
  billStatus,
  cancelVendorPayment,
  createVendorPayment,
  getVendorPayment,
  openBills,
  updateVendorPayment,
  type VendorPaymentInput,
} from "@/lib/vendor-payments";
import { createVendor, vendorOverview } from "@/lib/vendors";

// T19 (S9, S15, A§3, A§5, D49, D51): vendor payments allocate oldest bill first, the rest on account; bill statuses
// are computed; the vendor ledger's closing = the vendor's AP balance; statement PDF + share link.

let owner: SessionUser;
let accountant: SessionUser;
let cashId: string;
let categoryId: string;
const today = todayIST();

beforeAll(async () => {
  owner = await testOwner();
  const user = { name: "VP accountant", username: "vp.accountant", role: "accountant" as Role, canViewCost: true };
  accountant = { ...user, id: await createUser(owner, { ...user, password: "accountant-pass-123" }) };
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  cashId = String((await db.select().from(accounts).where(eq(accounts.systemKey, "cash")))[0].id);
  categoryId = String((await db.select().from(expenseCategories).where(eq(expenseCategories.name, "Labour")))[0].id);
});

const vendor = (name: string, creditDays = "", openingBalance?: string) =>
  createVendor(owner, { name, gstin: "", stateCode: "24", mobile: "9824000000", address: "Naroda, Ahmedabad", creditDays, notes: "", openingBalance });

/** A bill for `rupees` (an expense line at 0% GST, so the total is exact). */
async function bill(vendorId: number, no: string, rupees: string, date = today) {
  const input: BillInput = {
    vendorId: String(vendorId),
    vendorBillNo: no,
    date: formatDate(date),
    roundOff: "",
    notes: "",
    lines: JSON.stringify([{ what: `cat:${categoryId}`, description: "", qty: "1", rate: rupees, gst: "0", jobId: "" }]),
  };
  return (await createPurchaseBill(owner, input)).id!;
}

const payment = (vendorId: number, amount: string, lines: [number, string][] = [], date = today): VendorPaymentInput => ({
  vendorId: String(vendorId),
  date: formatDate(date),
  amount,
  mode: "cash",
  moneyAccountId: cashId,
  reference: "",
  chequeNo: "",
  chequeDate: "",
  notes: "",
  allocations: JSON.stringify(lines.map(([id, a]) => ({ id: String(id), amount: a }))),
});
const pay = async (actor: SessionUser, input: VendorPaymentInput) => (await createVendorPayment(actor, input)).id!;
const status = async (id: number, day?: string) => {
  const b = (await getPurchaseBill(id))!;
  return billStatus(b, b.open, day);
};

/** AP for the vendor straight from journal_lines (+ = we owe them). */
async function apOwed(vendorId: number) {
  const ap = (await db.select().from(accounts).where(eq(accounts.systemKey, "ap")))[0].id;
  const [row] = await db
    .select({ net: sql<string>`coalesce(sum(${journalLines.creditPaise} - ${journalLines.debitPaise}), 0)` })
    .from(journalLines)
    .where(and(eq(journalLines.accountId, ap), eq(journalLines.vendorId, vendorId)));
  return BigInt(row.net);
}

test("a payment is allocated across two bills, oldest first, and the rest stays on account; over-allocation is refused", async () => {
  const v = await vendor("VP Acrylic Traders");
  const older = await bill(v, "A-1", "1,000", addDays(today, -3));
  const newer = await bill(v, "A-2", "2,000");
  expect((await openBills(db, v)).map((b) => [b.id, b.open])).toEqual([
    [older, 1000_00n],
    [newer, 2000_00n],
  ]);
  await expect(pay(owner, payment(v, "3,500", [[older, "1,500"]]))).rejects.toThrow("₹1,500.00 is more than its open ₹1,000.00");
  await expect(pay(owner, payment(v, "500", [[older, "1,000"]]))).rejects.toThrow("₹1,000.00 allocated is more than the ₹500.00 paid");

  const id = await pay(owner, payment(v, "3,500", [[older, "1,000"], [newer, "2,000"]]));
  const p = (await getVendorPayment(id))!;
  expect(p.number).toMatch(/^VP\/26-27\/\d{4}$/);
  expect(p).toMatchObject({ allocated: 3000_00n, onAccount: 500_00n });
  expect(await openBills(db, v)).toEqual([]);
  // A§3: Dr ap (vendor) / Cr cash.
  expect(await apOwed(v)).toBe(1000_00n + 2000_00n - 3500_00n);
  expect((await vendorOverview(v)).lastPaymentDate).toBe(today);
});

test("bill status is computed: Unpaid → Part Payment → Paid, Overdue past the due date; a cancel reopens the bill", async () => {
  const v = await vendor("VP Status Metals", "5");
  const id = await bill(v, "S-1", "1,000");
  expect((await getPurchaseBill(id))!.dueDate).toBe(addDays(today, 5));
  expect(await status(id)).toBe("Unpaid");
  expect(await status(id, addDays(today, 6))).toBe("Overdue");
  const first = await pay(owner, payment(v, "400", [[id, "400"]]));
  expect(await status(id)).toBe("Part Payment");
  expect(await status(id, addDays(today, 6))).toBe("Overdue");
  await pay(owner, payment(v, "600", [[id, "600"]]));
  expect(await status(id)).toBe("Paid");
  expect(await status(id, addDays(today, 6))).toBe("Paid");
  expect((await listPurchaseBills(v)).map((b) => [b.payment, b.paid, b.open])).toEqual([["Paid", 1000_00n, 0n]]);

  await cancelVendorPayment(owner, first, "Cheque bounced");
  expect(await status(id)).toBe("Part Payment");
  // A bill can't be cut below what is paid on it; a cancelled bill sends its payments back on account.
  const lower = { vendorId: String(v), vendorBillNo: "S-1", date: formatDate(today), roundOff: "", notes: "", lines: JSON.stringify([{ what: `cat:${categoryId}`, description: "", qty: "1", rate: "500", gst: "0", jobId: "" }]) };
  await expect(updatePurchaseBill(owner, id, lower, "")).rejects.toThrow("₹600.00 is already paid against this bill");
  await cancelPurchaseBill(owner, id, "Wrong bill");
  expect(await status(id)).toBe("Cancelled");
  const [, second] = (await db.query.vendorPayments.findMany({ where: (p, { eq: e }) => e(p.vendorId, v), orderBy: (p, { asc }) => asc(p.id) })).map((p) => p.id);
  expect((await getVendorPayment(second))!).toMatchObject({ allocated: 0n, onAccount: 600_00n });
});

test("the accountant's edit and cancel wait for the owner; a backdated payment by a non-owner too", async () => {
  const v = await vendor("VP Approvals Co");
  const b = await bill(v, "P-1", "900");
  const id = await pay(owner, payment(v, "900", [[b, "900"]]));
  expect(await updateVendorPayment(accountant, id, payment(v, "800", [[b, "800"]]), "Paid less")).toEqual({ message: SENT_FOR_APPROVAL });
  expect((await getVendorPayment(id))!.amountPaise).toBe(900_00n);
  const [req] = await db.select().from(approvalRequests).where(and(eq(approvalRequests.type, "vendor_payment.edit"), eq(approvalRequests.targetId, id)));
  await approve(owner, req.id, "");
  expect((await getVendorPayment(id))!).toMatchObject({ amountPaise: 800_00n, allocated: 800_00n });
  expect(await status(b)).toBe("Part Payment");
  expect(await apOwed(v)).toBe(100_00n);

  expect(await cancelVendorPayment(accountant, id, "")).toEqual({ message: SENT_FOR_APPROVAL });
  expect(await createVendorPayment(accountant, payment(v, "100", [], addDays(today, -3)))).toEqual({ id: null, message: SENT_FOR_APPROVAL });
});

test("the vendor ledger's closing = the vendor's AP balance; the statement leaves out reversed pairs; share link works", async () => {
  const v = await vendor("VP Ledger Supplies", "", "5,000"); // opening: we owe ₹5,000
  const a = await bill(v, "L-1", "3,000", addDays(today, -6));
  await pay(owner, payment(v, "2,000", [[a, "2,000"]], addDays(today, -5)));
  const bounced = await pay(owner, payment(v, "700", [], addDays(today, -4)));
  await cancelVendorPayment(owner, bounced, "Returned");
  const edited = await pay(owner, payment(v, "1,000", [], addDays(today, -2)));
  await updateVendorPayment(owner, edited, payment(v, "1,200", [], addDays(today, -2)), "");

  // ₹5,000 + ₹3,000 − ₹2,000 − ₹1,200 = ₹4,800 owed (Cr).
  const all = await vendorLedger(v, { from: null, to: null });
  expect(all.closing).toBe(-4800_00n);
  expect(-all.closing).toBe(await apOwed(v));
  expect((await vendorOverview(v)).outstanding).toBe(4800_00n);
  const s = withoutReversed(all);
  expect(s.rows.map((r) => r.debit || r.credit)).toEqual([5000_00n, 3000_00n, 2000_00n, 1200_00n]);
  expect(s.closing).toBe(all.closing);

  const { range } = readRange("fy");
  const pdf = (await vendorStatementPdf(v, range))!;
  expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  await mkdir(".samples", { recursive: true });
  await writeFile(".samples/vendor-statement.pdf", pdf.bytes);
  const token = await createVendorStatementLink(owner, v, range);
  const res = await shareRoute(new Request(`http://x/share/${token}`), { params: Promise.resolve({ token }) });
  expect([res.status, res.headers.get("content-type")]).toEqual([200, "application/pdf"]);
}, 30_000);
