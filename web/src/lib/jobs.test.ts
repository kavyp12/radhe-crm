import { asc, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { jobLines, jobs, productCategories, quotationLines } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { createCustomer } from "@/lib/customers";
import {
  cancelJob,
  createJob,
  createJobFromQuotation,
  getJob,
  jobBoard,
  listJobs,
  setJobStatus,
  updateJob,
  type JobHeaderInput,
} from "@/lib/jobs";
import { lineText, type LineText } from "@/lib/lines";
import type { Role, SessionUser } from "@/lib/permissions";
import { approveQuotation, cancelQuotation, createQuotation, sendQuotation } from "@/lib/quotations";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";

let owner: SessionUser;
let sales: SessionUser;
let production: SessionUser;
let categoryId: string;
let customerId: number;

async function staff(role: Role): Promise<SessionUser> {
  const user = { name: `Job ${role}`, username: `job.${role}`, role, canViewCost: false };
  return { ...user, id: await createUser(owner, { ...user, password: `${role}-pass-123` }) };
}

beforeAll(async () => {
  owner = await testOwner();
  [sales, production] = [await staff("sales"), await staff("production")];
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const [c] = await db.select().from(productCategories).orderBy(productCategories.id).limit(1);
  categoryId = String(c.id);
  customerId = await createCustomer(owner, {
    name: "Om Sai Hospital",
    firmName: "",
    mobile: "",
    email: "",
    gstin: "",
    stateCode: "24",
    billingAddress: "",
    siteAddress: "Near Law Garden, Ahmedabad",
    creditLimit: "",
    creditDays: "",
    isCreditCustomer: false,
    salesPersonId: "",
    collectionPersonId: "",
    notes: "",
  });
});

const line = (patch: Partial<LineText> = {}): LineText => ({
  lineId: "",
  categoryId,
  description: "Glow sign board",
  hsnSac: "9403",
  width: "8",
  height: "3",
  qty: "",
  unit: "Sq Ft",
  rate: "350",
  discount: "200",
  gst: "",
  ...patch,
});
const header = (patch: Partial<JobHeaderInput> = {}): JobHeaderInput => ({
  date: "29/09/2026",
  siteAddress: "",
  siteReference: "Main gate",
  vehicleNo: "",
  salesPersonId: "",
  targetDate: "05/10/2026",
  notes: "",
  ...patch,
});

async function approvedQuotation() {
  const id = await createQuotation(sales, {
    customerId: String(customerId),
    date: "29/09/2026",
    terms: "",
    notes: "",
    lines: JSON.stringify([line(), line({ description: "Installation", width: "", height: "", qty: "1", unit: "Nos", rate: "1500", discount: "" })]),
  });
  await sendQuotation(owner, id);
  await approveQuotation(sales, id);
  return id;
}

const SHARED = [
  "position", "categoryId", "description", "hsnSac", "widthMilli", "heightMilli", "qtyMilli", "unit", "ratePaise",
  "discountPaise", "gstBp",
] as const;

test("quotation → job copies every line, nothing retyped; one job per quotation", async () => {
  const quotationId = await approvedQuotation();
  const jobId = await createJobFromQuotation(sales, quotationId, header());
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  expect(job).toMatchObject({
    customerId,
    quotationId,
    status: "in_production",
    siteAddress: "Near Law Garden, Ahmedabad", // blank → the customer's site address
    siteReference: "Main gate",
    targetDate: "2026-10-05",
  });
  expect(job.number).toMatch(/^RDS-2026-\d{5}$/);

  const from = await db.select().from(quotationLines).where(eq(quotationLines.quotationId, quotationId)).orderBy(asc(quotationLines.position));
  const copied = await db.select().from(jobLines).where(eq(jobLines.jobId, jobId)).orderBy(asc(jobLines.position));
  expect(copied).toHaveLength(2);
  const pick = (r: Record<string, unknown>) => Object.fromEntries(SHARED.map((k) => [k, r[k]]));
  expect(copied.map(pick)).toEqual(from.map(pick));
  expect(copied.map((l) => l.quotationLineId)).toEqual(from.map((l) => l.id));

  await expect(createJobFromQuotation(sales, quotationId, header())).rejects.toThrow(`Job ${job.number} was already made`);
  await expect(cancelQuotation(owner, quotationId)).rejects.toThrow("cancel the job first");

  // A cancelled job frees the quotation (and lets it be cancelled).
  await cancelJob(owner, jobId);
  await cancelQuotation(owner, quotationId);

  const draft = await createQuotation(sales, {
    customerId: String(customerId),
    date: "29/09/2026",
    terms: "",
    notes: "",
    lines: JSON.stringify([line()]),
  });
  await expect(createJobFromQuotation(sales, draft, header())).rejects.toThrow("Only an approved quotation");
});

test("status changes are recorded with who and when; invoiced / cancelled jobs don't move", async () => {
  const jobId = await createJobFromQuotation(sales, await approvedQuotation(), header());
  const before = new Date();
  await setJobStatus(production, jobId, "ready");
  await setJobStatus(owner, jobId, "delivered");
  await setJobStatus(production, jobId, "ready"); // a slip can be put back
  await expect(setJobStatus(production, jobId, "ready")).rejects.toThrow("already Ready");
  await expect(setJobStatus(production, jobId, "invoiced")).rejects.toThrow("Pick In Production, Ready or Delivered");

  const job = await getJob(owner, jobId);
  expect(job!.status).toBe("ready");
  expect(job!.history.map((h) => [h.from, h.to, h.by])).toEqual([
    [null, "in_production", sales.name],
    ["in_production", "ready", production.name],
    ["ready", "delivered", owner.name],
    ["delivered", "ready", production.name],
  ]);
  expect(job!.history.at(-1)!.at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);

  await cancelJob(owner, jobId);
  await expect(setJobStatus(production, jobId, "delivered")).rejects.toThrow("cancelled job's status can't change");
});

/** Every key anywhere in a value (objects, arrays). */
function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}
const MONEY = /rate|discount|amount|total|paise|gst|taxable|round|mode/i;

test("a production user's job, list and board data carry no money fields (stripped in the loader)", async () => {
  const jobId = await createJobFromQuotation(sales, await approvedQuotation(), header());
  const seen = [await getJob(production, jobId), await listJobs(production), await jobBoard(production)];
  const keys = [...keysDeep(seen)];
  expect(keys).toContain("qtyMilli"); // the work itself is there
  expect(keys).toContain("items");
  expect(keys.filter((k) => MONEY.test(k))).toEqual([]);

  // The owner sees the money.
  const full = await getJob(owner, jobId);
  expect(full).toHaveProperty("totals.total");
  expect(full!.lines[0]).toHaveProperty("ratePaise", 350_00n);
  expect((await listJobs(owner))[0]).toHaveProperty("total");
});

test("sales create jobs but can't change status; production only changes status; the owner edits lines", async () => {
  const lines = JSON.stringify([line()]);
  const input = { ...header(), customerId: String(customerId), lines };
  const blank = await createJob(sales, input);
  expect((await getJob(owner, blank))!.quotationId).toBeNull();

  await expect(setJobStatus(sales, blank, "ready")).rejects.toThrow("Not allowed");
  await expect(createJob(production, input)).rejects.toThrow("Not allowed");
  await expect(updateJob(production, blank, input)).rejects.toThrow("Not allowed");
  await expect(updateJob(sales, blank, input)).rejects.toThrow("Not allowed");
  await expect(cancelJob(production, blank)).rejects.toThrow("Not allowed");
  await expect(cancelJob(sales, blank)).rejects.toThrow("Not allowed");
  await setJobStatus(production, blank, "ready");

  // Owner edit: lines keep their quotation link through lineId.
  const fromQuote = await createJobFromQuotation(sales, await approvedQuotation(), header());
  const [first] = await db.select().from(jobLines).where(eq(jobLines.jobId, fromQuote)).orderBy(asc(jobLines.position));
  const kept = { ...lineText(first), rate: "400" };
  await updateJob(owner, fromQuote, { ...header(), customerId: "999999", lines: JSON.stringify([kept, line({ description: "Extra" })]) });
  const after = await db.select().from(jobLines).where(eq(jobLines.jobId, fromQuote)).orderBy(asc(jobLines.position));
  expect(after.map((l) => [l.description, l.ratePaise, l.quotationLineId])).toEqual([
    ["Glow sign board", 400_00n, first.quotationLineId],
    ["Extra", 350_00n, null],
  ]);
  expect((await getJob(owner, fromQuote))!.customerId).toBe(customerId); // the customer never changes on edit
});
