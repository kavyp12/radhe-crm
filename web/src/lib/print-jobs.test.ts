import { and, desc, eq, sql } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts, allocations, approvalRequests, auditLog, customers, invoiceLines, journalEntries, printJobs, receipts } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { openPrintJobs } from "@/lib/allocations";
import { approve, SENT_FOR_APPROVAL } from "@/lib/approvals";
import { createCustomer } from "@/lib/customers";
import { cancelInvoice, createInvoicesFromPrintJobs, getInvoice, issueInvoice } from "@/lib/invoices";
import { jobCosting } from "@/lib/job-costing";
import { createJob } from "@/lib/jobs";
import { printAmount, printSqFt } from "@/lib/num";
import type { SessionUser } from "@/lib/permissions";
import {
  cancelPrintJob,
  createPrintJob,
  getPrintJob,
  listMachines,
  listPrintJobs,
  saveMachine,
  savePrintingType,
  updatePrintJob,
  type PrintJobForm,
} from "@/lib/print-jobs";
import { createReceipt } from "@/lib/receipts";
import { search } from "@/lib/search";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";

// T37 (P2–P8, A§5, A§11, D19, D64): the P3 example, the A§5 statuses, a print on a job costing it, billing moving the
// money to the invoice and back, edit / cancel / reprint / quick add, and what each role sees. Print jobs and their
// receipts are dated 21–25/09/2026 (no other test file sums that week).

let owner: SessionUser;
let accountant: SessionUser;
let plain: SessionUser; // accountant without can_view_cost
let sales: SessionUser;
let production: SessionUser;
const ids: Record<string, number> = {};

beforeAll(async () => {
  owner = await testOwner();
  const user = async (username: string, role: SessionUser["role"], canViewCost: boolean) => {
    const u = { name: username, username, role, canViewCost };
    return { ...u, id: await createUser(owner, { ...u, password: `${username}-pass-1` }) };
  };
  accountant = await user("pj.acct", "accountant", true);
  plain = await user("pj.plain", "accountant", false);
  sales = await user("pj.sales", "sales", false);
  production = await user("pj.prod", "production", false);
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const [category] = await db.execute<{ id: string }>(sql`select id from product_categories order by id limit 1`);
  ids.category = Number(category.id);
  ids.uv = await saveMachine(owner, null, { name: "PJ UV Roll to Roll", printerNames: "UV-ROLL-1\nUV Roll, Floor 2", saleRate: "25", costRate: "12", active: true });
  ids.flex = await saveMachine(owner, null, { name: "PJ Flex", printerNames: "FLEX-1", saleRate: "", costRate: "", active: true });
  ids.uvType = await savePrintingType(owner, null, { name: "PJ UV print", categoryId: String(ids.category), active: true });
  ids.flexType = await savePrintingType(owner, null, { name: "PJ Flex print", categoryId: "", active: true });
  const customer = (name: string, isCreditCustomer: boolean, mobile = "") =>
    createCustomer(owner, {
      name, firmName: "", mobile, email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "", creditLimit: "", creditDays: "",
      isCreditCustomer, salesPersonId: "", collectionPersonId: "", notes: "",
    });
  ids.abc = await customer("PJ ABC Enterprise", false, "93750 64001"); // a mobile no other file uses (D68)
  ids.credit = await customer("PJ Credit Signs", true);
  const line = { lineId: "", categoryId: String(ids.category), description: "Shop board", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate: "20,000", discount: "", gst: "18" };
  ids.job = await createJob(owner, {
    customerId: String(ids.abc), date: "21/09/2026", siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "",
    lines: JSON.stringify([line]),
  });
}, 60000);

const form = (patch: Partial<PrintJobForm> = {}): PrintJobForm => ({
  customerId: String(ids.abc),
  newCustomerName: "",
  newCustomerMobile: "",
  jobId: "",
  fileName: "ABC_FRONT_BOARD.cdr",
  filePath: "D:\\RADHE JOBS\\ABC\\ABC_FRONT_BOARD.cdr",
  machineId: String(ids.uv),
  printingTypeId: String(ids.uvType),
  width: "6",
  height: "3",
  qty: "2",
  rate: "",
  payment: "unpaid",
  received: "",
  receiptMode: "",
  reprintOfId: "",
  notes: "",
  date: "21/09/2026",
  time: "10:30",
  ...patch,
});

async function create(patch: Partial<PrintJobForm> = {}, by = owner) {
  const { id } = await createPrintJob(by, form(patch));
  return id!;
}
const money = async (id: number, by = owner) => (await getPrintJob(by, id))!.money!;
const row = async (id: number) => (await db.select().from(printJobs).where(eq(printJobs.id, id)))[0];
const pay = (customerId: number, printJobId: number, amount: string, date = "23/09/2026") =>
  createReceipt(owner, {
    customerId: String(customerId), date, amount, mode: "cash", moneyAccountId: String(ids.cashAccount), reference: "", chequeNo: "", chequeDate: "",
    receivedBy: "", notes: "", allocations: JSON.stringify([{ target: "print_job", id: String(printJobId), amount }]),
  });
const liveOn = (printJobId: number) =>
  db.select().from(allocations).where(and(eq(allocations.printJobId, printJobId), eq(allocations.active, true)));

test("P3: 6 × 3 ft × 2 = 36 sq ft at ₹25 = ₹900, numbered PJ/26-27/…, nothing posted until billed", async () => {
  ids.cashAccount = (await db.select().from(accounts).where(eq(accounts.systemKey, "cash")))[0].id;
  expect([printSqFt(6000n, 3000n, 2000n), printAmount(36000n, 2500n)]).toEqual([36000n, 900_00n]);
  // Both rounded half-up (D64): 1.111 × 1.5 × 1 = 1.6665 → 1.667 sq ft; × ₹3.33 = ₹5.55111 → ₹5.55.
  expect([printSqFt(1111n, 1500n, 1000n), printAmount(1667n, 333n)]).toEqual([1667n, 555n]);

  const entries = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(journalEntries))[0].n;
  const before = await entries();
  const id = await create();
  const pj = await row(id);
  expect(pj).toMatchObject({ mode: "sale", sqftMilli: 36000n, ratePaise: 2500n, amountPaise: 900_00n, date: "2026-09-21", jobId: null, status: "active" });
  expect(pj.number).toMatch(/^PJ\/26-27\/\d{5}$/);
  expect(pj.printedAt.toISOString()).toBe("2026-09-21T05:00:00.000Z"); // 10:30 in India
  expect(pj.operatorUserId).toBe(owner.id);
  expect(await entries()).toBe(before); // a sale print posts nothing until it is billed (D64)
  ids.p3 = id;
});

test("statuses (A§5): Unpaid → Part Payment → Paid as money comes in; Credit Customer for a credit customer", async () => {
  const id = await create();
  expect(await money(id)).toMatchObject({ payment: "Unpaid", received: 0n, balance: 900_00n, invoice: null });
  await pay(ids.abc, id, "400");
  expect(await money(id)).toMatchObject({ payment: "Part Payment", received: 400_00n, balance: 500_00n });
  await pay(ids.abc, id, "500");
  expect(await money(id)).toMatchObject({ payment: "Paid", received: 900_00n, balance: 0n });
  await expect(pay(ids.abc, id, "1")).rejects.toThrow("is more than its open");

  const credit = await create({ customerId: String(ids.credit), payment: "credit" });
  expect((await money(credit)).payment).toBe("Credit Customer");
  const advance = await create({ customerId: String(ids.credit), payment: "unpaid", received: "100", receiptMode: "cash" });
  expect((await money(advance)).payment).toBe("Part Payment");
  // An ordinary customer on credit is Unpaid (Credit Customer is the customer's flag, never typed).
  expect((await money(await create({ payment: "credit" }))).payment).toBe("Unpaid");

  // Paid at the print: a receipt into UPI for the full amount, received by the operator, allocated to the print job.
  const paid = await create({ payment: "paid", receiptMode: "upi" });
  expect(await money(paid)).toMatchObject({ payment: "Paid", received: 900_00n, balance: 0n });
  const [a] = await liveOn(paid);
  const [r] = await db.select().from(receipts).where(eq(receipts.id, a.receiptId!));
  const [upi] = await db.select().from(accounts).where(eq(accounts.systemKey, "upi"));
  expect(r).toMatchObject({ amountPaise: 900_00n, mode: "upi", moneyAccountId: upi.id, receivedBy: owner.id, date: "2026-09-21", customerId: ids.abc });
  expect(r.number).toMatch(/^RC\/26-27\//);
  // Paid means the full amount; an advance can't be more than the amount; money needs a mode.
  await expect(create({ payment: "paid", received: "500", receiptMode: "cash" })).rejects.toThrow("Paid means the full ₹900.00");
  await expect(create({ payment: "unpaid", received: "901", receiptMode: "cash" })).rejects.toThrow("between 0 and ₹900.00");
  await expect(create({ payment: "unpaid", received: "100" })).rejects.toThrow("Pick Cash or UPI");
  await expect(create({ payment: "credit", received: "100", receiptMode: "cash" })).rejects.toThrow("Credit takes no money");
  await expect(create({ payment: "maybe" })).rejects.toThrow("Pick Paid, Unpaid or Credit");
});

test("a print on an existing job adds sq ft × the machine's cost rate to that job's printing cost", async () => {
  const before = (await jobCosting(owner, ids.job))!.cost.printing;
  const id = await create({ jobId: String(ids.job), payment: "" });
  expect(await row(id)).toMatchObject({ mode: "job_cost", jobId: ids.job, ratePaise: 1200n, amountPaise: 432_00n }); // 36 sq ft × ₹12
  expect((await jobCosting(owner, ids.job))!.cost.printing - before).toBe(432_00n);
  // The cost rate is the server's (D64): a typed rate or money at the print is refused.
  await expect(create({ jobId: String(ids.job), payment: "", rate: "5" })).rejects.toThrow("leave the rate blank");
  await expect(create({ jobId: String(ids.job), payment: "paid", receiptMode: "cash" })).rejects.toThrow("takes no money here");
  // A sale on a machine with no sale rate needs one typed.
  await expect(create({ machineId: String(ids.flex) })).rejects.toThrow("enter the rate per sq ft");
  expect(await row(await create({ machineId: String(ids.flex), rate: "18.50" }))).toMatchObject({ ratePaise: 1850n, amountPaise: 666_00n });
  // Another customer's job, or one that is cancelled / invoiced, is refused.
  await expect(create({ customerId: String(ids.credit), jobId: String(ids.job), payment: "" })).rejects.toThrow("another customer's");
  // Follows the job (A§5): nothing paid on the job yet → Unpaid.
  expect((await money(id)).payment).toBe("Unpaid");
  // Cancelled → it drops out of the job's printing cost.
  await cancelPrintJob(owner, id);
  expect((await jobCosting(owner, ids.job))!.cost.printing).toBe(before);
});

test("D66: a job print on a machine with no cost rate is saved with its cost pending; setting the rate costs it (audited)", async () => {
  const card = async () => (await jobCosting(owner, ids.job))!;
  const before = await card();
  const id = await create({ jobId: String(ids.job), payment: "", machineId: String(ids.flex) });
  expect(await row(id)).toMatchObject({ mode: "job_cost", ratePaise: null, amountPaise: null });
  expect([(await card()).cost.printing, (await card()).printsCostPending]).toEqual([before.cost.printing, before.printsCostPending + 1]);
  expect((await getPrintJob(owner, id))!.costPending).toBe(true);
  expect((await getPrintJob(production, id))!).toMatchObject({ costPending: true, amountPaise: null });
  // A cancelled pending print stays as it was.
  const dropped = await create({ jobId: String(ids.job), payment: "", machineId: String(ids.flex), qty: "1" });
  await cancelPrintJob(owner, dropped);
  // A no-cost accountant's save doesn't touch the rate, so nothing is costed.
  await saveMachine(plain, ids.flex, { name: "PJ Flex", printerNames: "FLEX-1", saleRate: "", costRate: "10", active: true });
  expect((await row(id)).ratePaise).toBeNull();

  await saveMachine(accountant, ids.flex, { name: "PJ Flex", printerNames: "FLEX-1", saleRate: "", costRate: "10", active: true });
  expect(await row(id)).toMatchObject({ ratePaise: 1000n, amountPaise: 360_00n }); // 36 sq ft × ₹10
  expect(await row(dropped)).toMatchObject({ ratePaise: null, amountPaise: null });
  expect([(await card()).cost.printing - before.cost.printing, (await card()).printsCostPending]).toEqual([360_00n, before.printsCostPending]);
  const [log] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tableName, "print_jobs"), eq(auditLog.rowId, String(id)), eq(auditLog.action, "update")))
    .orderBy(desc(auditLog.id));
  expect([log.userId, log.oldData!.rate_paise, log.newData!.rate_paise]).toEqual([accountant.id, null, 1000]);
  await cancelPrintJob(owner, id);
  await saveMachine(owner, ids.flex, { name: "PJ Flex", printerNames: "FLEX-1", saleRate: "", costRate: "", active: true });
});

test("billing moves the print job's money to the invoice; billed can't be billed or changed again; cancelling the invoice puts it back", async () => {
  const id = await create({ payment: "unpaid", received: "300", receiptMode: "cash" });
  const [draft] = await createInvoicesFromPrintJobs(owner, [id], "tax", "");
  const [l] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, draft));
  expect(l).toMatchObject({ printJobId: id, categoryId: ids.category, qtyMilli: 36000n, ratePaise: 2500n, unit: "Sq Ft", widthMilli: 6000n, heightMilli: 3000n });
  // D66: "<printing type> — <W × H> ft × <n> pc (PJ/…)", no file name on the customer's invoice.
  expect(l.description).toBe(`PJ UV print — 6 × 3 ft × 2 pc (${(await row(id)).number})`);
  await expect(createInvoicesFromPrintJobs(owner, [id], "tax", "")).rejects.toThrow("already on invoice");
  await expect(cancelPrintJob(owner, id)).rejects.toThrow("is billed");
  // On a draft the money still sits on the print job, and it no longer takes more (it is billed).
  expect(await liveOn(id)).toHaveLength(1);
  expect((await openPrintJobs(db, ids.abc)).map((p) => p.id)).not.toContain(id);

  await issueInvoice(owner, draft);
  expect(await liveOn(id)).toHaveLength(0);
  const moved = await db.select().from(allocations).where(and(eq(allocations.invoiceId, draft), eq(allocations.active, true)));
  expect(moved.map((a) => [a.fromPrintJobId, a.amountPaise])).toEqual([[id, 300_00n]]);
  const inv = (await getInvoice(draft))!;
  expect([inv.totalPaise, inv.advance, inv.open, inv.payment]).toEqual([1062_00n, 300_00n, 762_00n, "Part Payment"]); // ₹900 + 18% GST
  expect(await money(id)).toMatchObject({ payment: "Part Payment", received: 300_00n, balance: null, invoice: { id: draft, issued: true } });

  await cancelInvoice(owner, draft, "wrong customer");
  const back = await liveOn(id);
  expect(back.map((a) => a.amountPaise)).toEqual([300_00n]);
  expect(await money(id)).toMatchObject({ payment: "Part Payment", balance: 600_00n, invoice: null });
  // Unbilled again: it can be billed again.
  expect(await createInvoicesFromPrintJobs(owner, [id], "estimate", "")).toHaveLength(1);
});

test("bill selected: one draft per customer; a type without a category takes the one picked; jobs' prints and cancelled ones refused", async () => {
  const a = await create({ printingTypeId: String(ids.flexType), fileName: "A1.pdf" });
  const b = await create({ customerId: String(ids.credit), payment: "credit", fileName: "B1.pdf" });
  await expect(createInvoicesFromPrintJobs(owner, [a, b], "tax", "")).rejects.toThrow("Pick the category");
  const drafts = await createInvoicesFromPrintJobs(owner, [a, b], "tax", String(ids.category));
  expect(drafts).toHaveLength(2);
  const onJob = await create({ jobId: String(ids.job), payment: "" });
  await expect(createInvoicesFromPrintJobs(owner, [onJob], "tax", "")).rejects.toThrow("is on a job");
  const cancelled = await create();
  await cancelPrintJob(owner, cancelled);
  await expect(createInvoicesFromPrintJobs(owner, [cancelled], "tax", "")).rejects.toThrow("is cancelled");
  await expect(createInvoicesFromPrintJobs(sales, [a], "tax", "")).rejects.toThrow("Not allowed");
});

test("edit / cancel: owner and accountant, audited; money taken stays; cancel puts it on account", async () => {
  const id = await create({ payment: "unpaid", received: "450", receiptMode: "cash" });
  const edit = { customerId: String(ids.abc), jobId: "", fileName: "ABC_FRONT_BOARD_v2.cdr", filePath: "", machineId: String(ids.uv), printingTypeId: String(ids.uvType), width: "6", height: "3", qty: "3", rate: "25", notes: "" };
  await updatePrintJob(accountant, id, edit);
  expect(await row(id)).toMatchObject({ qtyMilli: 3000n, sqftMilli: 54000n, amountPaise: 1350_00n, fileName: "ABC_FRONT_BOARD_v2.cdr" });
  const [log] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tableName, "print_jobs"), eq(auditLog.rowId, String(id)), eq(auditLog.action, "update")))
    .orderBy(desc(auditLog.id));
  expect(log.userId).toBe(accountant.id);
  expect([log.oldData!.qty_milli, log.newData!.qty_milli]).toEqual([2000, 3000]);
  // ₹450 was taken: 18 sq ft × ₹20 = ₹360 is too little; the customer or new → job can't change either.
  await expect(updatePrintJob(owner, id, { ...edit, qty: "1", rate: "20" })).rejects.toThrow("can't go below that");
  await expect(updatePrintJob(owner, id, { ...edit, customerId: String(ids.credit) })).rejects.toThrow("cancel it and enter it again");
  await expect(updatePrintJob(owner, id, { ...edit, jobId: String(ids.job) })).rejects.toThrow("cancel it and enter it again");
  for (const who of [sales, production]) {
    await expect(updatePrintJob(who, id, edit)).rejects.toThrow("Not allowed");
    await expect(cancelPrintJob(who, id)).rejects.toThrow("Not allowed");
    await expect(createPrintJob(who, form())).rejects.toThrow("Not allowed");
  }

  const [a] = await liveOn(id);
  await cancelPrintJob(accountant, id);
  expect(await row(id)).toMatchObject({ status: "cancelled" });
  expect(await liveOn(id)).toHaveLength(0);
  expect((await money(id)).payment).toBe("Cancelled");
  // The receipt stays; its ₹450 is on account now (D64).
  const [r] = await db.select().from(receipts).where(eq(receipts.id, a.receiptId!));
  const [used] = await db
    .select({ n: sql<string>`coalesce(sum(${allocations.amountPaise}), 0)` })
    .from(allocations)
    .where(and(eq(allocations.receiptId, r.id), eq(allocations.active, true)));
  expect([r.status, r.amountPaise - BigInt(used.n)]).toEqual(["active", 450_00n]);
  await expect(cancelPrintJob(owner, id)).rejects.toThrow("is cancelled");
  await expect(db.delete(printJobs).where(eq(printJobs.id, id))).rejects.toThrow(); // never deleted (hard rule 3)
});

test("reprint (P8): a new print job of its own, linked to the one it reprints", async () => {
  const id = await create({ qty: "1", reprintOfId: String(ids.p3) });
  expect(await row(id)).toMatchObject({ reprintOfId: ids.p3, qtyMilli: 1000n, sqftMilli: 18000n, amountPaise: 450_00n });
  expect((await getPrintJob(owner, ids.p3))!.reprints.map((r) => r.id)).toContain(id);
  await expect(create({ reprintOfId: "999999" })).rejects.toThrow("this reprints wasn't found");
});

test("quick-add customer (D64): name + mobile makes an unregistered state-24 customer; an existing mobile reuses that customer", async () => {
  const fresh = await create({ customerId: "", newCustomerName: "PJ Walk-in Ramesh", newCustomerMobile: "+91 99090 22222", payment: "credit" });
  const [c] = await db.select().from(customers).where(eq(customers.id, (await row(fresh)).customerId));
  expect(c).toMatchObject({ name: "PJ Walk-in Ramesh", mobile: "+91 99090 22222", stateCode: "24", gstin: null, active: true });
  // Same 10 digits typed differently → the same customer, not a second one.
  const again = await create({ customerId: "", newCustomerName: "Ramesh bhai", newCustomerMobile: "9909022222", payment: "credit" });
  expect((await row(again)).customerId).toBe(c.id);
  // ABC's mobile (93750 64001) → ABC.
  expect((await row(await create({ customerId: "", newCustomerName: "Someone", newCustomerMobile: "9375064001", payment: "credit" }))).customerId).toBe(ids.abc);
  await expect(create({ customerId: "", newCustomerName: "No Mobile", payment: "credit" })).rejects.toThrow("10-digit mobile");
  await expect(create({ customerId: "", newCustomerName: "", payment: "credit" })).rejects.toThrow("Pick the customer");
});

test("what each role sees (A§8): production no money; a print on a job's rate and amount are cost (can_view_cost)", async () => {
  const onJob = await create({ jobId: String(ids.job), payment: "", fileName: "JOB_PANEL.pdf" });
  const prod = await listPrintJobs(production);
  expect(prod.length).toBeGreaterThan(0);
  expect(prod.every((r) => r.ratePaise === null && r.amountPaise === null && r.money === null)).toBe(true);
  expect((await getPrintJob(production, ids.p3))!.money).toBeNull();
  const salesRows = await listPrintJobs(sales);
  expect(salesRows.find((r) => r.id === ids.p3)).toMatchObject({ ratePaise: 2500n, amountPaise: 900_00n });
  expect(salesRows.find((r) => r.id === onJob)).toMatchObject({ ratePaise: null, amountPaise: null });
  expect((await listPrintJobs(plain)).find((r) => r.id === onJob)).toMatchObject({ ratePaise: null, amountPaise: null });
  expect((await listPrintJobs(accountant)).find((r) => r.id === onJob)).toMatchObject({ ratePaise: 1200n, amountPaise: 432_00n });
  expect((await listMachines(plain)).find((m) => m.id === ids.uv)).toMatchObject({ saleRatePaise: 2500n, costRatePaise: undefined });
  // An accountant without can_view_cost can't change a cost rate by saving the machine.
  await saveMachine(plain, ids.uv, { name: "PJ UV Roll to Roll", printerNames: "UV-ROLL-1\nUV Roll, Floor 2", saleRate: "25", costRate: "1", active: true });
  expect((await listMachines(owner)).find((m) => m.id === ids.uv)!.costRatePaise).toBe(1200n);
  // Search (S26): by number and by file name; production gets no amount, a job print's amount never shows.
  const pj = await row(ids.p3);
  const hits = async (who: SessionUser, q: string) => (await search(who, q)).find((g) => g.label === "Print jobs")?.hits ?? [];
  expect((await hits(owner, pj.number))[0]).toMatchObject({ href: `/print-jobs/${ids.p3}`, amount: "₹900.00" });
  const panel = (await hits(owner, "job_panel")).find((h) => h.href === `/print-jobs/${onJob}`);
  expect(panel && [panel.href, panel.amount]).toEqual([`/print-jobs/${onJob}`, undefined]);
  expect((await hits(production, pj.number))[0]).toEqual({ title: pj.number, detail: expect.stringContaining("ABC_FRONT_BOARD.cdr"), href: `/print-jobs/${ids.p3}` });
});

test("a printer feeds one machine; machine and type names are unique", async () => {
  await expect(saveMachine(owner, null, { name: "PJ Other", printerNames: "uv-roll-1", saleRate: "", costRate: "", active: true })).rejects.toThrow(
    "already feeds PJ UV Roll to Roll",
  );
  await expect(saveMachine(owner, null, { name: "pj flex", printerNames: "", saleRate: "", costRate: "", active: true })).rejects.toThrow("Another machine");
  await expect(savePrintingType(owner, null, { name: "PJ UV PRINT", categoryId: "", active: true })).rejects.toThrow("Another printing type");
  await expect(saveMachine(production, null, { name: "X", printerNames: "", saleRate: "", costRate: "", active: true })).rejects.toThrow("Not allowed");
});

test("dated before the backdate window by a non-owner → an approval request; the owner's approval saves it", async () => {
  const before = await db.select({ id: printJobs.id }).from(printJobs);
  expect(await createPrintJob(accountant, form({ fileName: "BACKDATED.cdr", date: "22/09/2026" }))).toEqual({ id: null, message: SENT_FOR_APPROVAL });
  expect(await db.select({ id: printJobs.id }).from(printJobs)).toHaveLength(before.length);
  const [req] = await db.select().from(approvalRequests).where(eq(approvalRequests.type, "print_job.create")).orderBy(desc(approvalRequests.id)).limit(1);
  expect(req.summary).toContain("BACKDATED.cdr");
  await approve(owner, req.id, "");
  const [pj] = await db.select().from(printJobs).where(eq(printJobs.fileName, "BACKDATED.cdr"));
  expect(pj).toMatchObject({ operatorUserId: accountant.id, date: "2026-09-22", amountPaise: 900_00n });
});

test("refusals: a future time, before the books start, unknown machine or type, sizes", async () => {
  await expect(create({ date: "01/01/2030" })).rejects.toThrow("in the future");
  await expect(create({ date: "31/03/2026" })).rejects.toThrow("The books start on 01/04/2026");
  await expect(create({ time: "25:00" })).rejects.toThrow("Enter the time");
  await expect(create({ machineId: "999999" })).rejects.toThrow("Pick the machine");
  await expect(create({ printingTypeId: "" })).rejects.toThrow("Pick the printing type");
  await expect(create({ width: "0" })).rejects.toThrow("width (ft)");
  await expect(create({ height: "abc" })).rejects.toThrow("height (ft)");
  await expect(create({ qty: "-1" })).rejects.toThrow("quantity");
  await expect(create({ width: "0.001", height: "0.001", qty: "1" })).rejects.toThrow("0 sq ft");
  await expect(create({ fileName: "  " })).rejects.toThrow("file name");
  await expect(create({ rate: "-5" })).rejects.toThrow("rate between 0");
});
