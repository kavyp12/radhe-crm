import { and, desc, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import type { SessionUser } from "@/lib/permissions";
import { getSettings, percentText, updateSettings, type SettingsInput } from "@/lib/settings";

// Other test files only set the books start date or restore what they change, so the order below is the life of
// these fields in a test run.

let owner: SessionUser;
beforeAll(async () => {
  owner = await testOwner();
});

const blank: SettingsInput = {
  companyName: "",
  address: "",
  gstin: "",
  stateCode: "24",
  phone: "",
  email: "",
  bankDetails: "",
  upiId: "",
  invoiceTerms: "",
  discountLimit: "",
  backdateDays: "",
  defaultCreditDays: "",
};

const settingsAudit = () =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tableName, "settings"), eq(auditLog.rowId, "1")))
    .orderBy(desc(auditLog.id));

test("settings start empty except state code 24", async () => {
  const s = await getSettings();
  expect(s.stateCode).toBe("24");
  expect([s.companyName, s.gstin, s.bankDetails, s.upiId, s.invoiceTerms, s.logoAttachmentId]).toEqual([
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  expect([s.discountLimitBp, s.backdateDays, s.defaultCreditDays]).toEqual([null, null, null]);
});

test("a settings update through the write helper writes one audit row with the user and old → new", async () => {
  const before = (await settingsAudit()).length;
  await updateSettings(owner, { ...blank, companyName: "Radhe Digital Sign Board", discountLimit: "12.5" });
  const rows = await settingsAudit();
  expect(rows).toHaveLength(before + 1);
  expect(rows[0]).toMatchObject({ action: "update", userId: owner.id });
  expect(rows[0].oldData).toMatchObject({ company_name: null, discount_limit_bp: null });
  expect(rows[0].newData).toMatchObject({ company_name: "Radhe Digital Sign Board", discount_limit_bp: 1250 });

  await updateSettings(owner, { ...blank, companyName: "Radhe Digital Sign Board", discountLimit: "12.5" });
  expect(await settingsAudit()).toHaveLength(before + 2); // updated_at moved, so it is a real (if dull) change
});

test("settings save and reload", async () => {
  const input: SettingsInput = {
    companyName: "  Radhe Digital Sign Board ",
    address: "Line 1\nAhmedabad",
    gstin: "24abcde1234f1z5",
    stateCode: "24",
    phone: "98250 00000",
    email: "office@example.com",
    bankDetails: "Bank X\nA/c 123456\nIFSC ABCD0123456",
    upiId: "radhe@upi",
    invoiceTerms: "Subject to Ahmedabad jurisdiction.",
    discountLimit: "10",
    backdateDays: "3",
    defaultCreditDays: "15",
  };
  await updateSettings(owner, input);
  const s = await getSettings();
  expect(s).toMatchObject({
    companyName: "Radhe Digital Sign Board",
    address: "Line 1\nAhmedabad",
    gstin: "24ABCDE1234F1Z5",
    stateCode: "24",
    phone: "98250 00000",
    email: "office@example.com",
    bankDetails: "Bank X\nA/c 123456\nIFSC ABCD0123456",
    upiId: "radhe@upi",
    invoiceTerms: "Subject to Ahmedabad jurisdiction.",
    discountLimitBp: 1000,
    backdateDays: 3,
    defaultCreditDays: 15,
  });
  expect(percentText(s.discountLimitBp)).toBe("10");

  await updateSettings(owner, { ...input, upiId: " " });
  expect((await getSettings()).upiId).toBeNull(); // blank = not set
});

test("bad values are refused, naming the field", async () => {
  const cases: [Partial<SettingsInput>, string][] = [
    [{ gstin: "27ABCDE1234F1Z5" }, "gstin"], // another state's GSTIN
    [{ gstin: "24ABCDE1234" }, "gstin"],
    [{ stateCode: "Gujarat" }, "stateCode"],
    [{ discountLimit: "120" }, "discountLimit"],
    [{ discountLimit: "ten" }, "discountLimit"],
    [{ backdateDays: "-1" }, "backdateDays"],
    [{ email: "office" }, "email"],
    [{ upiId: "radhe" }, "upiId"],
  ];
  for (const [patch, field] of cases) {
    await expect(updateSettings(owner, { ...blank, ...patch })).rejects.toMatchObject({ field });
  }
});

test("only the owner can change settings", async () => {
  await expect(updateSettings({ ...owner, role: "accountant" }, blank)).rejects.toThrow("Not allowed");
});

test("percent text round-trips basis points without floats", () => {
  expect([null, 0, 5, 1000, 1205, 1250, 10000].map(percentText)).toEqual(["", "0", "0.05", "10", "12.05", "12.5", "100"]);
});
