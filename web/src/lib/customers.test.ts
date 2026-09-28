import { and, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db, writeTx } from "@/db";
import { auditLog, customers, settings } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import {
  createCustomer,
  customerOverview,
  duplicateText,
  findDuplicates,
  getCustomer,
  listCustomers,
  updateCustomer,
  type CustomerInput,
} from "@/lib/customers";
import { GST_STATES, gstinCheckChar, gstinProblem, stateName } from "@/lib/gstin";
import { ledger } from "@/lib/ledger";
import type { Role, SessionUser } from "@/lib/permissions";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";

let owner: SessionUser;
let sales: SessionUser;
let accountant: SessionUser;
let production: SessionUser;

async function staff(role: Role): Promise<SessionUser> {
  const user = { name: `Customer ${role}`, username: `cust.${role}`, role, canViewCost: false };
  return { ...user, id: await createUser(owner, { ...user, password: `${role}-pass-123` }) };
}

beforeAll(async () => {
  owner = await testOwner();
  [sales, accountant, production] = [await staff("sales"), await staff("accountant"), await staff("production")];
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
});

const base: CustomerInput = {
  name: "Shree Ganesh Traders",
  firmName: "",
  email: "",
  mobile: "98250 11111",
  gstin: "",
  stateCode: "24",
  billingAddress: "",
  siteAddress: "",
  creditLimit: "",
  creditDays: "",
  isCreditCustomer: false,
  salesPersonId: "",
  collectionPersonId: "",
  notes: "",
};

test("GSTIN: format, check digit (Luhn mod 36) and state", () => {
  expect(gstinCheckChar("27AAPFU0939F1Z")).toBe("V"); // 27AAPFU0939F1ZV: the GST system's published sample GSTIN
  expect(gstinProblem("27AAPFU0939F1ZV", "27")).toBeNull();
  expect(gstinProblem("27AAPFU0939F1ZX", "27")).toMatch("last character");
  expect(gstinProblem("27AAPFU0939F1ZV", "24")).toMatch("from state 27");
  expect(gstinProblem("27AAPFU0939F1Z", "27")).toMatch("15 characters");
  expect(gstinProblem("27aapfu0939f1zv", "27")).toMatch("15 characters"); // callers uppercase first

  expect(GST_STATES).toHaveLength(40);
  expect(new Set(GST_STATES.map(([code]) => code)).size).toBe(40);
  expect([stateName("24"), stateName("27"), stateName("28")]).toEqual(["Gujarat", "Maharashtra", undefined]);
});

test("a customer is saved only with a GSTIN that checks out and matches the state", async () => {
  await expect(createCustomer(owner, { ...base, gstin: "27AAPFU0939F1ZX", stateCode: "27" })).rejects.toMatchObject({
    field: "gstin",
  });
  await expect(createCustomer(owner, { ...base, gstin: "27AAPFU0939F1ZV", stateCode: "24" })).rejects.toMatchObject({
    field: "gstin",
  });
  await expect(createCustomer(owner, { ...base, stateCode: "28" })).rejects.toMatchObject({ field: "stateCode" });
  await expect(createCustomer(owner, { ...base, name: " " })).rejects.toMatchObject({ field: "name" });
  await expect(createCustomer(owner, { ...base, mobile: "call me" })).rejects.toMatchObject({ field: "mobile" });
  await expect(createCustomer(owner, { ...base, salesPersonId: "nobody" })).rejects.toMatchObject({
    field: "salesPersonId",
  });

  const id = await createCustomer(owner, { ...base, gstin: "27aapfu 0939f1zv", stateCode: "27", salesPersonId: sales.id });
  expect(await getCustomer(id)).toMatchObject({ gstin: "27AAPFU0939F1ZV", stateCode: "27", salesPerson: sales.name });
  const unregistered = await createCustomer(owner, base);
  expect(await getCustomer(unregistered)).toMatchObject({ gstin: null, stateCode: "24" });
});

test("opening balance: shows in the customer's AR ledger; a change reverses + reposts; minus = Cr", async () => {
  const id = await createCustomer(owner, { ...base, name: "Opening Co", openingBalance: "25,000" });
  let ar = await ledger({ account: "ar", customerId: id });
  expect(ar.rows.map((r) => [r.date, r.docType, r.docId, r.debit, r.credit])).toEqual([
    ["2026-04-01", "customers", id, 25_000_00n, 0n],
  ]);
  expect(ar.closing).toBe(25_000_00n);

  await updateCustomer(owner, id, { ...base, name: "Opening Co", openingBalance: "-1,500.50" });
  ar = await ledger({ account: "ar", customerId: id });
  expect(ar.rows.map((r) => [r.debit, r.credit])).toEqual([
    [25_000_00n, 0n],
    [0n, 25_000_00n],
    [0n, 1_500_50n],
  ]);
  expect(ar.closing).toBe(-1_500_50n);
  expect((await ledger({ account: "opening_equity" }, "2026-04-01", "2026-04-01")).rows.at(-1)).toMatchObject({
    docType: "customers",
    docId: id,
    debit: 1_500_50n,
  });

  // The list and the overview read the journal.
  expect((await listCustomers()).find((c) => c.id === id)?.outstanding).toBe(-1_500_50n);
  expect(await customerOverview(id)).toEqual({
    business: 0n,
    received: 0n,
    outstanding: -1_500_50n,
    lastPaymentDate: null,
  });

  // Same amount again → nothing new is posted.
  await updateCustomer(owner, id, { ...base, name: "Opening Co Renamed", openingBalance: "-1500.50" });
  expect((await ledger({ account: "ar", customerId: id })).rows).toHaveLength(3);
  await expect(updateCustomer(owner, id, { ...base, openingBalance: "12.345" })).rejects.toMatchObject({
    field: "openingBalance",
  });
});

test("an edit is audited with the user and old → new", async () => {
  const id = await createCustomer(sales, { ...base, name: "Audit Traders" });
  await updateCustomer(sales, id, { ...base, name: "Audit Traders", mobile: "98250 22222" });
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tableName, "customers"), eq(auditLog.rowId, String(id))))
    .orderBy(auditLog.id);
  expect(rows.map((r) => [r.action, r.userId])).toEqual([
    ["insert", sales.id],
    ["update", sales.id],
  ]);
  expect(rows[1].oldData).toMatchObject({ mobile: "98250 11111" });
  expect(rows[1].newData).toMatchObject({ mobile: "98250 22222" });
});

test("sales can create and edit, but not set an opening balance or deactivate; production can't at all", async () => {
  await expect(createCustomer(sales, { ...base, openingBalance: "100" })).rejects.toMatchObject({
    field: "openingBalance",
  });
  const id = await createCustomer(sales, base);
  await expect(updateCustomer(sales, id, { ...base, openingBalance: "0" })).rejects.toMatchObject({
    field: "openingBalance",
  });
  await expect(updateCustomer(sales, id, { ...base, active: false })).rejects.toMatchObject({ field: "active" });
  expect((await ledger({ account: "ar", customerId: id })).rows).toHaveLength(0);

  await updateCustomer(accountant, id, { ...base, active: false, openingBalance: "500" });
  expect(await getCustomer(id)).toMatchObject({ active: false, openingBalancePaise: 500_00n });
  await expect(createCustomer(production, base)).rejects.toThrow("Not allowed");
  await expect(updateCustomer(production, id, base)).rejects.toThrow("Not allowed");
});

test("credit days default from Settings when left blank on create", async () => {
  const [saved] = await db.select({ days: settings.defaultCreditDays }).from(settings);
  const setDefault = (days: number | null) =>
    writeTx(owner, (tx) => tx.update(settings).set({ defaultCreditDays: days }).where(eq(settings.id, 1)));
  try {
    await setDefault(15);
    expect((await getCustomer(await createCustomer(owner, base)))?.creditDays).toBe(15);
    expect((await getCustomer(await createCustomer(owner, { ...base, creditDays: "30" })))?.creditDays).toBe(30);
    await setDefault(null);
    expect((await getCustomer(await createCustomer(owner, base)))?.creditDays).toBeNull();
  } finally {
    await setDefault(saved.days);
  }
});

test("duplicate GSTIN / mobile: found for a warning, never blocked (D46)", async () => {
  const gstin = "24AAACD1234E1Z3";
  const first = await createCustomer(owner, { ...base, name: "Dupe One", gstin: gstinWithCheck(gstin), mobile: "98250 77777" });
  const second = await createCustomer(owner, { ...base, name: "Dupe Two", gstin: "", mobile: "+91 9825077777" });
  expect(second).toBeGreaterThan(first); // saved anyway

  const found = await findDuplicates(customers, gstinWithCheck(gstin).toLowerCase(), "", undefined);
  expect(found.map((d) => [d.name, d.same])).toEqual([["Dupe One", "GSTIN"]]);
  const byMobile = await findDuplicates(customers, "", "098250-77777", second);
  expect(byMobile.map((d) => [d.name, d.same])).toEqual([["Dupe One", "mobile"]]);
  expect(duplicateText(byMobile, "customer")).toContain("Dupe One (same mobile)");
  expect(await findDuplicates(customers, "", "123")).toEqual([]);
});

const gstinWithCheck = (g: string) => g.slice(0, 14) + gstinCheckChar(g.slice(0, 14));
