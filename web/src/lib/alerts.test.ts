import { eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts, followUps } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { createAdjustment } from "@/lib/adjustments";
import { alertsFor, type AlertKind } from "@/lib/alerts";
import { createCustomer, type CustomerInput } from "@/lib/customers";
import { addDays, formatDate, todayIST } from "@/lib/dates";
import { createFollowUp, myFollowUpsDueCount, type FollowUpInput } from "@/lib/follow-ups";
import { createInvoice, issueInvoice } from "@/lib/invoices";
import type { Role, SessionUser } from "@/lib/permissions";
import { createPurchaseBill } from "@/lib/purchase-bills";
import { cancelReceipt, createReceipt } from "@/lib/receipts";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";
import { createVendor } from "@/lib/vendors";

// T29 (S8, S25, D22, D57): alerts are queries — due today / overdue by due date, a broken promise until the expected
// amount is received since the follow-up, credit limit exceeded; each user only sees areas they can open. "My
// follow-ups" = my latest follow-ups per customer with the next reminder due.

let owner: SessionUser;
const staff: Partial<Record<Role, SessionUser>> = {};
let categoryId: string;
let cash: number;
const today = todayIST();
const day = (n: number) => addDays(today, n);

beforeAll(async () => {
  owner = await testOwner();
  for (const [role, canViewCost] of [["accountant", true], ["sales", false], ["production", false]] as [Role, boolean][]) {
    const user = { name: `AL ${role}`, username: `al.${role}`, role, canViewCost };
    staff[role] = { ...user, id: await createUser(owner, { ...user, password: `${role}-pass-123` }) };
  }
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  categoryId = String((await db.query.productCategories.findFirst())!.id);
  cash = (await db.select().from(accounts).where(eq(accounts.systemKey, "cash")))[0].id;
});

const customer = (name: string, patch: Partial<CustomerInput> = {}) =>
  createCustomer(owner, {
    name, firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
    creditLimit: "", creditDays: "0", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "", ...patch,
  });
async function invoice(customerId: number, rupees: string, date = today) {
  const line = { lineId: "", categoryId, description: "Board", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate: rupees, discount: "", gst: "0" };
  const id = await createInvoice(owner, { kind: "tax", customerId: String(customerId), date: formatDate(date), terms: "", notes: "", lines: JSON.stringify([line]) });
  await issueInvoice(owner, id);
  return id;
}
const receipt = async (customerId: number, amount: string, date = today) =>
  (await createReceipt(owner, {
    customerId: String(customerId), date: formatDate(date), amount, mode: "cash", moneyAccountId: String(cash), reference: "", chequeNo: "",
    chequeDate: "", receivedBy: "", notes: "", allocations: "[]",
  })).id!;
const followUp = (actor: SessionUser, customerId: number, patch: Partial<FollowUpInput> = {}) =>
  createFollowUp(actor, {
    customerId: String(customerId), invoiceId: "", followUpDate: formatDate(today), personId: actor.id, response: "Will pay soon",
    promiseDate: "", expected: "", nextReminderDate: "", ...patch,
  });
/** One customer's / one follow-up's alerts of a kind, seen by `user` on `date`. */
const find = async (user: SessionUser, date: string, kind: AlertKind, key: string) =>
  (await alertsFor(user, date)).find((a) => a.kind === kind && a.key === key);

test("a broken promise raises an alert until the expected amount is received since the follow-up", async () => {
  const c = await customer("AL Promise Customer");
  await invoice(c, "10,000");
  await receipt(c, "1,000", day(-1)); // before the follow-up: doesn't count
  const { id } = await followUp(staff.sales!, c, { promiseDate: formatDate(day(2)), expected: "6,000", nextReminderDate: formatDate(day(1)) });
  const key = `promise:${id}`;

  expect(await find(owner, day(1), "promise_due", key)).toBeUndefined(); // not due yet
  expect(await find(owner, day(2), "promise_due", key)).toMatchObject({ amount: 6000_00n });
  expect(await find(staff.sales!, day(3), "promise_broken", key)).toMatchObject({ title: "AL Promise Customer", amount: 6000_00n });

  await receipt(c, "4,000");
  expect(await find(owner, day(3), "promise_broken", key)).toMatchObject({ amount: 2000_00n }); // still ₹2,000 short
  const last = await receipt(c, "2,000");
  expect(await find(owner, day(3), "promise_broken", key)).toBeUndefined(); // kept: cleared
  await cancelReceipt(owner, last, "Bounced");
  expect(await find(owner, day(3), "promise_broken", key)).toMatchObject({ amount: 2000_00n }); // computed, so it's back
});

test("due today vs overdue, and credit limit exceeded", async () => {
  const d = await customer("AL Due Customer");
  await invoice(d, "500");
  expect(await find(owner, today, "due_today", `due:${d}`)).toMatchObject({ amount: 500_00n });
  expect(await find(owner, today, "overdue", `overdue:${d}`)).toBeUndefined();
  expect(await find(staff.sales!, day(1), "overdue", `overdue:${d}`)).toMatchObject({ amount: 500_00n });
  expect(await find(owner, day(1), "due_today", `due:${d}`)).toBeUndefined();

  const l = await customer("AL Limit Customer", { creditLimit: "1,000", creditDays: "30" });
  await invoice(l, "900");
  expect(await find(owner, today, "credit_limit", `limit:${l}`)).toBeUndefined();
  await invoice(l, "300");
  expect(await find(owner, today, "credit_limit", `limit:${l}`)).toMatchObject({ amount: 200_00n }); // ₹1,200 due, limit ₹1,000
});

test("a sales user doesn't see vendor-payment or approval alerts; production sees none", async () => {
  const v = await createVendor(owner, { name: "AL Supplier", gstin: "", stateCode: "24", mobile: "", address: "", creditDays: "", notes: "" });
  const [labour] = await db.query.expenseCategories.findMany({ where: (e, { eq }) => eq(e.name, "Labour") });
  await createPurchaseBill(owner, {
    vendorId: String(v), vendorBillNo: "AL-1", date: formatDate(today), roundOff: "", notes: "",
    lines: JSON.stringify([{ what: `cat:${labour.id}`, description: "", qty: "1", rate: "750", gst: "0", jobId: "" }]),
  });
  // The accountant's JV waits for the owner (A§7).
  const [capital] = await db.select().from(accounts).where(eq(accounts.systemKey, "capital"));
  await createAdjustment(staff.accountant!, {
    kind: "journal", date: formatDate(today), narration: "Alert test", customerId: "", amount: "", moneyAccountId: "", allocations: "[]",
    lines: JSON.stringify([{ accountId: String(cash), debit: "1" }, { accountId: String(capital.id), credit: "1" }]),
  });

  const kinds = async (user: SessionUser) => new Set((await alertsFor(user)).map((a) => a.kind));
  expect(await find(owner, today, "vendor_due", `vendor:${v}`)).toMatchObject({ amount: 750_00n });
  expect(await find(staff.accountant!, today, "vendor_due", `vendor:${v}`)).toBeDefined();
  expect((await kinds(owner)).has("approvals")).toBe(true);
  expect((await kinds(staff.accountant!)).has("approvals")).toBe(false);
  const sales = await kinds(staff.sales!);
  expect([sales.has("vendor_due"), sales.has("approvals"), sales.has("due_today")]).toEqual([false, false, true]);
  expect(await alertsFor(staff.production!)).toEqual([]);
});

test("my follow-ups: mine, the customer's latest, next reminder on or before today; a promise needs date and amount", async () => {
  const c = await customer("AL Reminder Customer");
  const sales = staff.sales!;
  const count = (user: SessionUser, date: string) => myFollowUpsDueCount(user, date);
  // Baselines: follow-ups from the other tests.
  const [salesToday, salesTomorrow, ownerTomorrow, ownerLater] = [await count(sales, today), await count(sales, day(1)), await count(owner, day(1)), await count(owner, day(5))];
  await followUp(sales, c, { nextReminderDate: formatDate(day(1)) });
  expect([await count(sales, today), await count(sales, day(1)), await count(owner, day(1))]).toEqual([salesToday, salesTomorrow + 1, ownerTomorrow]);
  // A later follow-up (by someone else) takes over the reminder.
  await followUp(owner, c, { nextReminderDate: formatDate(day(5)) });
  expect([await count(sales, day(1)), await count(owner, day(5))]).toEqual([salesTomorrow, ownerLater + 1]);
  expect(await myFollowUpsDueCount(staff.production!, day(9))).toBe(0);

  await expect(followUp(sales, c, { promiseDate: formatDate(day(2)) })).rejects.toThrow("Enter the amount promised.");
  await expect(followUp(sales, c, { expected: "100" })).rejects.toThrow("Enter the date the payment was promised for.");
  await expect(followUp(sales, c, { nextReminderDate: formatDate(day(-1)) })).rejects.toThrow("The next reminder can't be before the follow-up.");
  // A log: never changed.
  await expect(db.update(followUps).set({ response: "edited" }).where(eq(followUps.customerId, c))).rejects.toThrow();
});
