import { and, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { ledger } from "@/lib/ledger";
import type { Role, SessionUser } from "@/lib/permissions";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";
import { createVendor, getVendor, listVendors, updateVendor, vendorOverview, type VendorInput } from "@/lib/vendors";

let owner: SessionUser;
let accountant: SessionUser;
let sales: SessionUser;

async function staff(role: Role): Promise<SessionUser> {
  const user = { name: `Vendor ${role}`, username: `vend.${role}`, role, canViewCost: role === "accountant" };
  return { ...user, id: await createUser(owner, { ...user, password: `${role}-pass-123` }) };
}

beforeAll(async () => {
  owner = await testOwner();
  [accountant, sales] = [await staff("accountant"), await staff("sales")];
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
});

const base: VendorInput = {
  name: "Shakti Acrylics",
  gstin: "",
  stateCode: "24",
  mobile: "98980 00000",
  address: "",
  creditDays: "",
  notes: "",
};

test("vendor opening balance: + = we owe them (Cr ap), shows in the AP ledger; a change reverses + reposts", async () => {
  const id = await createVendor(accountant, { ...base, openingBalance: "10,000" });
  let ap = await ledger({ account: "ap", vendorId: id });
  expect(ap.rows.map((r) => [r.date, r.docType, r.docId, r.debit, r.credit])).toEqual([
    ["2026-04-01", "vendors", id, 0n, 10_000_00n],
  ]);
  expect(ap.closing).toBe(-10_000_00n); // Dr − Cr: a credit balance
  expect((await listVendors()).find((v) => v.id === id)?.outstanding).toBe(10_000_00n);

  await updateVendor(accountant, id, { ...base, openingBalance: "-2,000" }); // they owe us
  ap = await ledger({ account: "ap", vendorId: id });
  expect(ap.rows.map((r) => [r.debit, r.credit])).toEqual([
    [0n, 10_000_00n],
    [10_000_00n, 0n],
    [2_000_00n, 0n],
  ]);
  expect(ap.closing).toBe(2_000_00n);
  expect(await vendorOverview(id)).toEqual({ billed: 0n, paid: 0n, outstanding: -2_000_00n, lastPaymentDate: null });
});

test("vendors get the same GSTIN / state checks, and edits are audited", async () => {
  await expect(createVendor(owner, { ...base, gstin: "27AAPFU0939F1ZV", stateCode: "24" })).rejects.toMatchObject({
    field: "gstin",
  });
  await expect(createVendor(owner, { ...base, gstin: "27AAPFU0939F1ZX", stateCode: "27" })).rejects.toMatchObject({
    field: "gstin",
  });
  const id = await createVendor(owner, { ...base, gstin: "27AAPFU0939F1ZV", stateCode: "27" });
  await updateVendor(owner, id, { ...base, gstin: "27AAPFU0939F1ZV", stateCode: "27", creditDays: "30", active: false });
  expect(await getVendor(id)).toMatchObject({ creditDays: 30, active: false, gstin: "27AAPFU0939F1ZV" });
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tableName, "vendors"), eq(auditLog.rowId, String(id))))
    .orderBy(auditLog.id);
  expect(rows.map((r) => [r.action, r.userId])).toEqual([
    ["insert", owner.id],
    ["update", owner.id],
  ]);
  expect(rows[1].newData).toMatchObject({ credit_days: 30, active: false });
});

test("vendors are owner + accountant only", async () => {
  await expect(createVendor(sales, base)).rejects.toThrow("Not allowed");
  const id = await createVendor(accountant, base);
  await expect(updateVendor(sales, id, base)).rejects.toThrow("Not allowed");
});
