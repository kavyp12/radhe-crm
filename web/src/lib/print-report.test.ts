import { and, eq, sql } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { printJobs } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { createCustomer } from "@/lib/customers";
import { loadDashboard } from "@/lib/dashboard";
import { formatDate, todayIST } from "@/lib/dates";
import { createInvoicesFromPrintJobs, issueInvoice } from "@/lib/invoices";
import { createJob } from "@/lib/jobs";
import type { SessionUser } from "@/lib/permissions";
import { cancelPrintJob, createPrintJob, printingToday, printPendingReport, saveMachine, savePrintingType, type PrintJobForm } from "@/lib/print-jobs";
import { columnTotal } from "@/lib/report";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";

// T38 (P6, P7, P9): the dashboard's Printing today against today's print jobs, and report #20 "Printed But Payment
// Pending" listing exactly the pending ones with matching totals; a cancelled print job is in neither. The report's
// prints are dated 26/09/2026 (only print job tests make print jobs; T37's use 21–25/09).

let owner: SessionUser;
let sales: SessionUser;
let production: SessionUser;
let plain: SessionUser; // accountant without can_view_cost
const ids: Record<string, number> = {};
const today = todayIST();

beforeAll(async () => {
  owner = await testOwner();
  const user = async (username: string, role: SessionUser["role"], canViewCost: boolean) => {
    const u = { name: username, username, role, canViewCost };
    return { ...u, id: await createUser(owner, { ...u, password: `${username}-pass-1` }) };
  };
  sales = await user("pr.sales", "sales", false);
  production = await user("pr.prod", "production", false);
  plain = await user("pr.plain", "accountant", false);
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const [category] = await db.execute<{ id: string }>(sql`select id from product_categories order by id limit 1`);
  ids.machine = await saveMachine(owner, null, { name: "PR Eco Solvent", printerNames: "ECO-1", saleRate: "20", costRate: "9", active: true });
  ids.type = await savePrintingType(owner, null, { name: "PR Vinyl", categoryId: category.id, active: true });
  const customer = (name: string, isCreditCustomer: boolean) =>
    createCustomer(owner, {
      name, firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "", creditLimit: "", creditDays: "",
      isCreditCustomer, salesPersonId: "", collectionPersonId: "", notes: "",
    });
  ids.walkIn = await customer("PR Walk-in", false);
  ids.credit = await customer("PR Credit Co", true);
  ids.job = await createJob(owner, {
    customerId: String(ids.walkIn), date: "26/09/2026", siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "",
    lines: JSON.stringify([{ lineId: "", categoryId: category.id, description: "Board", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate: "5,000", discount: "", gst: "18" }]),
  });
});

/** 5 × 2 ft × 1 = 10 sq ft at ₹20 = ₹200 unless changed. */
const print = async (patch: Partial<PrintJobForm>) => {
  const { id } = await createPrintJob(owner, {
    customerId: String(ids.walkIn), newCustomerName: "", newCustomerMobile: "", jobId: "", fileName: "PR.pdf", filePath: "", machineId: String(ids.machine),
    printingTypeId: String(ids.type), width: "5", height: "2", qty: "1", rate: "", payment: "unpaid", received: "", receiptMode: "", reprintOfId: "",
    notes: "", date: "26/09/2026", time: "09:00", ...patch,
  });
  return id!;
};
const numberOf = async (id: number) => (await db.select({ n: printJobs.number }).from(printJobs).where(eq(printJobs.id, id)))[0].n;

test("Printing today: the tiles equal today's print jobs; a cancelled one and a job's cost aren't sales", async () => {
  const before = await printingToday();
  const now = { date: formatDate(today), time: "00:00" }; // midnight in India: today, never in the future
  await print({ ...now }); // ₹200 unpaid
  await print({ ...now, received: "50", receiptMode: "cash" }); // part: ₹150 pending
  await print({ ...now, payment: "paid", receiptMode: "upi" }); // paid
  await print({ ...now, customerId: String(ids.credit), payment: "credit", qty: "2" }); // ₹400 credit
  await print({ ...now, jobId: String(ids.job), payment: "" }); // on a job: counted and sq ft, its ₹90 cost is no sale
  const cancelled = await print({ ...now, received: "200", receiptMode: "cash" });
  await cancelPrintJob(owner, cancelled);

  const after = await printingToday();
  expect({
    jobs: after.jobs - before.jobs,
    sqftMilli: after.sqftMilli - before.sqftMilli,
    value: after.value - before.value,
    received: after.received - before.received,
    pending: after.pending - before.pending,
  }).toEqual({ jobs: 5, sqftMilli: 60_000n, value: 1000_00n, received: 250_00n, pending: 750_00n });
  expect(after.received + after.pending).toBe(after.value);

  // The same figures straight from today's print jobs (whichever test file made them).
  const [direct] = await db
    .select({
      jobs: sql<number>`count(*)::int`,
      sqft: sql<string>`coalesce(sum(${printJobs.sqftMilli}), 0)`,
      value: sql<string>`coalesce(sum(${printJobs.amountPaise}) filter (where ${printJobs.mode} = 'sale'), 0)`,
    })
    .from(printJobs)
    .where(and(eq(printJobs.date, today), eq(printJobs.status, "active")));
  expect([after.jobs, after.sqftMilli, after.value]).toEqual([direct.jobs, BigInt(direct.sqft), BigInt(direct.value)]);

  // On the dashboard for owner / accountant only (not sales, who has no Printing panel).
  expect((await loadDashboard(owner, today)).printing).toEqual(after);
  expect((await loadDashboard(plain, today)).printing).toEqual(after); // no cost in it
  expect((await loadDashboard(sales, today)).printing).toBeNull();
});

test("report #20 lists exactly the Unpaid / Part Payment / Credit (and billed Overdue / Unpaid) prints; totals match; cancelled, paid and job prints left out", async () => {
  const at = (time: string) => ({ date: "26/09/2026", time });
  const unpaid = await print(at("09:00"));
  const part = await print({ ...at("09:10"), received: "80", receiptMode: "cash" });
  const paid = await print({ ...at("09:20"), payment: "paid", receiptMode: "cash" });
  const credit = await print({ ...at("09:30"), customerId: String(ids.credit), payment: "credit" });
  const cancelled = await print({ ...at("09:40"), received: "20", receiptMode: "cash" });
  await cancelPrintJob(owner, cancelled);
  const onJob = await print({ ...at("09:50"), jobId: String(ids.job), payment: "" });
  // Billed on an issued invoice with ₹30 taken at the print: it follows the invoice (₹236 − ₹30 open → Part Payment).
  const billed = await print({ ...at("10:00"), received: "30", receiptMode: "cash" });
  const [invoice] = await createInvoicesFromPrintJobs(owner, [billed], "tax", "");
  await issueInvoice(owner, invoice);

  const q = { period: "custom", from: "26/09/2026", to: "26/09/2026" };
  const r = (await printPendingReport(owner, q))!;
  const [main, byStatus] = r.report.tables;
  const numbers = await Promise.all([unpaid, part, credit, billed].map(numberOf));
  expect(main.rows.map((x) => [x.number, x.status, x.amount, x.received, x.balance])).toEqual([
    [numbers[0], "Unpaid", 200_00n, 0n, 200_00n],
    [numbers[1], "Part Payment", 200_00n, 80_00n, 120_00n],
    [numbers[2], "Credit Customer", 200_00n, 0n, 200_00n],
    [numbers[3], "Part Payment", 200_00n, 30_00n, 170_00n],
  ]);
  expect(main.rows[3].invoice).toMatch(/^RDS\/26-27\//);
  for (const id of [paid, cancelled, onJob]) expect(main.rows.map((x) => x.number)).not.toContain(await numberOf(id));
  expect([columnTotal(main, "amount"), columnTotal(main, "received"), columnTotal(main, "balance")]).toEqual([800_00n, 110_00n, 690_00n]);
  expect(byStatus.rows.map((x) => [x.status, x.count, x.balance])).toEqual([
    ["Unpaid", 1n, 200_00n],
    ["Part Payment", 2n, 290_00n],
    ["Credit Customer", 1n, 200_00n],
  ]);
  expect([columnTotal(byStatus, "amount"), columnTotal(byStatus, "balance")]).toEqual([800_00n, 690_00n]);
  // Each row has customer, machine and operator, and opens its print job.
  expect(main.rows[0]).toMatchObject({ customer: "PR Walk-in", machine: "PR Eco Solvent", operator: owner.name, href: `/print-jobs/${unpaid}` });

  // Filters: a status; the period only narrows by print date (all dates by default, as of today).
  expect((await printPendingReport(owner, { ...q, status: "Part Payment" }))!.report.tables[0].rows.map((x) => x.number)).toEqual([numbers[1], numbers[3]]);
  const all = (await printPendingReport(owner, {}))!;
  expect(all.period).toBe("all");
  expect(all.report.tables[0].rows.map((x) => x.number)).toEqual(expect.arrayContaining(numbers));

  // Owner / accountant (no cost in it); not sales or production.
  expect(await printPendingReport(plain, q)).not.toBeNull();
  expect(await printPendingReport(sales, q)).toBeNull();
  expect(await printPendingReport(production, q)).toBeNull();
});
