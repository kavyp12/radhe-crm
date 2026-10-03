import { eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import {
  listExpenseCategories,
  listProductCategories,
  saveExpenseCategory,
  saveProductCategory,
} from "@/lib/categories";
import { navFor } from "@/lib/nav";
import { can, type SessionUser } from "@/lib/permissions";

let owner: SessionUser;
beforeAll(async () => {
  owner = await testOwner();
});

// SPEC S4 / S10, and the D41 buckets.
const S4 = ["LED Sign Board", "Acrylic Channel Letter", "ACP Elevation", "Glow Sign Board", "Flex Banner",
  "Vinyl Printing", "One Way Vision", "Frosted Film", "UV Printing", "CNC Cutting", "Laser Cutting",
  "Aluminium Channel Letter", "Installation/Fitting", "Other"];
const S10: [string, string][] = [
  ["Acrylic", "material"], ["ACP", "material"], ["LED Module", "material"], ["SMPS", "material"],
  ["Aluminium", "material"], ["Flex", "material"], ["Vinyl", "material"], ["Ink", "material"],
  ["Welding Material", "material"], ["Electrical Material", "material"], ["Labour", "labour"],
  ["Installation", "installation"], ["Transport", "transport"], ["Diesel/Petrol", "transport"],
  ["Machine Repair", "none"], ["Electricity", "none"], ["Rent", "none"], ["Salary", "none"],
  ["Office Expense", "none"], ["Marketing", "none"], ["Miscellaneous", "other"],
];

// D68: this file edits only categories it adds — every other file prices lines on the seeded ones (the first product
// category's GST %, Rent for bills and expenses) — and checks the seeded ones by name, not the whole table.
test("after migrate: the 14 S4 and 21 S10 categories, each expense category with its own expense account", async () => {
  const products = (await listProductCategories()).filter((p) => S4.includes(p.name));
  expect(products.map((p) => [p.name, p.hsnSac, p.gstBp, p.active])).toEqual(S4.map((n) => [n, null, 1800, true]));

  const expenses = (await listExpenseCategories()).filter((e) => S10.some(([n]) => n === e.name));
  expect(expenses.map((e) => [e.name, e.costBucket])).toEqual(S10);
  expect(new Set(expenses.map((e) => e.accountId)).size).toBe(21);
  const own = await db.select().from(accounts);
  for (const [i, e] of expenses.entries()) {
    const account = own.find((a) => a.id === e.accountId);
    expect(account).toMatchObject({ code: String(6001 + i), name: e.name, type: "expense", systemKey: null });
  }
});

test("owner / accountant edit HSN/SAC, GST % and the bucket, add categories, deactivate; bad values refused", async () => {
  await saveProductCategory(owner, null, { name: "CT Board", hsnSac: "", gstPercent: "18", active: true });
  const led = (await listProductCategories()).find((p) => p.name === "CT Board")!;
  await saveProductCategory(owner, led.id, { name: "", hsnSac: "9403 20", gstPercent: "12.5", active: true });
  expect((await listProductCategories()).find((p) => p.id === led.id)).toMatchObject({ name: "CT Board", hsnSac: "940320", gstBp: 1250 });
  const good = { name: "", hsnSac: "", gstPercent: "18", active: true };
  for (const [patch, field] of [
    [{ hsnSac: "94A3" }, "hsnSac"],
    [{ hsnSac: "123" }, "hsnSac"],
    [{ gstPercent: "" }, "gstPercent"],
    [{ gstPercent: "101" }, "gstPercent"],
    [{ gstPercent: "18.005" }, "gstPercent"],
  ] as const) {
    await expect(saveProductCategory(owner, led.id, { ...good, ...patch })).rejects.toMatchObject({ field });
  }

  const accountant = { ...owner, role: "accountant" as const };
  await saveProductCategory(accountant, null, { name: "Neon Sign", hsnSac: "", gstPercent: "18", active: true });
  await expect(
    saveProductCategory(accountant, null, { name: "neon sign", hsnSac: "", gstPercent: "18", active: true }),
  ).rejects.toMatchObject({ field: "name" });

  await saveExpenseCategory(owner, null, { name: "CT Rent", costBucket: "none", active: true });
  const rent = (await listExpenseCategories()).find((e) => e.name === "CT Rent")!;
  await saveExpenseCategory(accountant, rent.id, { name: "", costBucket: "other", active: false });
  expect((await listExpenseCategories()).find((e) => e.id === rent.id)).toMatchObject({ costBucket: "other", active: false });
  await expect(saveExpenseCategory(owner, rent.id, { name: "", costBucket: "misc", active: true })).rejects.toMatchObject({
    field: "costBucket",
  });

  // A new expense category gets its own new expense account.
  await saveExpenseCategory(owner, null, { name: "Paint", costBucket: "material", active: true });
  const paint = (await listExpenseCategories()).find((e) => e.name === "Paint")!;
  const [account] = await db.select().from(accounts).where(eq(accounts.id, paint.accountId));
  expect(account).toMatchObject({ code: expect.stringMatching(/^60\d\d$/), name: "Paint", type: "expense" });
  expect(Number(account.code)).toBeGreaterThan(6021); // after the 21 seeded ones
});

test("categories are closed to sales and production", async () => {
  for (const role of ["sales", "production"] as const) {
    const user = { ...owner, role };
    expect(can(user, "categories")).toBe(false);
    expect(navFor(user).flatMap((g) => g.items.map((i) => i.label))).not.toContain("Categories");
    await expect(saveProductCategory(user, null, { name: "X", hsnSac: "", gstPercent: "18", active: true })).rejects.toThrow(
      "Not allowed",
    );
    await expect(saveExpenseCategory(user, null, { name: "X", costBucket: "none", active: true })).rejects.toThrow(
      "Not allowed",
    );
  }
});
