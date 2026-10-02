// `pnpm db:volume` (T42, D67): wipes radhe_test, fills it with about 3 years of synthetic data through the app's own
// services (so every posting, allocation and number is real), then times the dashboard, every report, search,
// outstanding and a customer ledger in-process (server time). `pnpm db:volume time` re-times without refilling.
// Refuses any DB not named *_test (test-setup.ts). `pnpm test` wipes radhe_test again afterwards.
// Env: VOLUME_DAYS (default 1096 = 3 years, ending yesterday), VOLUME_CONCURRENCY (default 8).

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const DAYS = Number(process.env.VOLUME_DAYS ?? 1096);
const CONCURRENCY = Number(process.env.VOLUME_CONCURRENCY ?? 8);

/** Deterministic: the same data every fill. */
let seed = 42;
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pickOf = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
/** How many today, averaging `perDay` (fractions carried by chance). */
const howMany = (perDay: number) => Math.floor(perDay) + (rand() < perDay % 1 ? 1 : 0);

async function pool<T>(tasks: (() => Promise<T>)[], size = CONCURRENCY): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]();
      }
    }),
  );
  return out;
}

async function fill() {
  const { default: reset } = await import("./test-setup");
  await reset();
  const { db, writeTx } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const { testOwner } = await import("./test-owner");
  const { createUser } = await import("@/lib/users");
  const { saveBooks } = await import("@/lib/settings");
  const { createCustomer } = await import("@/lib/customers");
  const { createVendor } = await import("@/lib/vendors");
  const { createItem } = await import("@/lib/stock");
  const { createInvoice, createInvoiceFromJobs, issueInvoice } = await import("@/lib/invoices");
  const { createJob } = await import("@/lib/jobs");
  const { createReceipt } = await import("@/lib/receipts");
  const { createPurchaseBill } = await import("@/lib/purchase-bills");
  const { createVendorPayment } = await import("@/lib/vendor-payments");
  const { createExpense } = await import("@/lib/expenses");
  const { createStockIssue } = await import("@/lib/stock-issues");
  const { createPrintJob, saveMachine, savePrintingType } = await import("@/lib/print-jobs");
  const { createFollowUp } = await import("@/lib/follow-ups");
  const { createNote, invoiceLinesLeft, issueNote } = await import("@/lib/notes");
  const { gstinCheckChar } = await import("@/lib/gstin");
  const { addDays, formatDate, todayIST } = await import("@/lib/dates");

  const started = Date.now();
  const owner = await testOwner();
  const people: string[] = [];
  for (const n of ["Jaydeep", "Mehul", "Kiran"]) {
    people.push(await createUser(owner, { name: n, username: `vol.${n.toLowerCase()}`, role: "sales", canViewCost: false, password: `${n}-pass-123` }));
  }
  await saveBooks(owner, { booksStartDate: "01/04/2023", accounts: [] });
  const accounts = Object.fromEntries(
    (await db.execute<{ system_key: string; id: string }>(sql`select system_key, id from accounts where system_key is not null`)).map((a) => [a.system_key, a.id]),
  );
  const productCategories = (await db.execute<{ id: string }>(sql`select id from product_categories`)).map((c) => c.id);
  const expenseCats = await db.execute<{ id: string; name: string; cost_bucket: string }>(sql`select id, name, cost_bucket from expense_categories`);
  const materialCats = expenseCats.filter((c) => c.cost_bucket === "material");
  const spendCats = expenseCats.filter((c) => c.cost_bucket !== "material");

  // Masters: 1,500 customers (a fifth registered, some out of state), 100 vendors, 200 items, 3 machines, 4 types.
  const FIRST = ["Shree", "Jay", "Om", "Radhe", "Krishna", "Patel", "Shah", "Mahavir", "Sai", "Ambika", "Navkar", "Umiya", "Gayatri", "Balaji", "Siddhi"];
  const LAST = ["Enterprise", "Traders", "Signs", "Furniture", "Motors", "Jewellers", "Hospital", "Builders", "Textiles", "Foods", "Electronics", "Agency"];
  const customers: number[] = [];
  await pool(
    Array.from({ length: 1500 }, (_, i) => async () => {
      const registered = i % 5 === 0;
      const state = i % 17 === 0 ? "27" : "24";
      const first14 = `${state}AAAP${String.fromCharCode(65 + (i % 26))}${String(1000 + i).slice(-4)}Q1Z`;
      customers[i] = await createCustomer(owner, {
        name: `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]} ${i + 1}`,
        firmName: i % 3 === 0 ? `${FIRST[(i + 3) % FIRST.length]} Group` : "",
        mobile: `9${String(800000000 + i * 7919).slice(-9)}`,
        email: "",
        gstin: registered ? first14 + gstinCheckChar(first14) : "",
        stateCode: state,
        billingAddress: "Ahmedabad",
        siteAddress: "",
        creditLimit: "",
        creditDays: String(pickOf([0, 7, 15, 30])),
        isCreditCustomer: i % 10 === 0,
        salesPersonId: pickOf(people),
        collectionPersonId: pickOf(people),
        notes: "",
      });
    }),
  );
  const vendors: number[] = [];
  for (let i = 0; i < 100; i++) {
    vendors.push(await createVendor(owner, { name: `${FIRST[i % FIRST.length]} Supply ${i + 1}`, gstin: "", stateCode: "24", mobile: "", address: "", creditDays: "30", notes: "" }));
  }
  const items: number[] = [];
  for (let i = 0; i < 200; i++) {
    const cat = materialCats[i % materialCats.length];
    items.push(
      await createItem(owner, {
        name: `${cat.name} item ${i + 1}`, unit: "Nos", categoryId: cat.id, hsnSac: "", gstPercent: "18", openingQty: "1000000", openingRate: String(int(20, 900)),
      }),
    );
  }
  const machines = [
    await saveMachine(owner, null, { name: "Konica 512i", printerNames: "KONICA-1", saleRate: "18", costRate: "8", active: true }),
    await saveMachine(owner, null, { name: "UV Flatbed", printerNames: "UV-1", saleRate: "45", costRate: "20", active: true }),
    await saveMachine(owner, null, { name: "Eco Solvent", printerNames: "ECO-1", saleRate: "25", costRate: "10", active: true }),
  ];
  const types: number[] = [];
  for (const name of ["Flex", "Vinyl", "One way vision", "Backlit"]) types.push(await savePrintingType(owner, null, { name, categoryId: productCategories[0], active: true }));
  console.log(`masters in ${((Date.now() - started) / 1000).toFixed(0)} s`);

  // Documents, day by day (a day's documents in parallel; receipts / payments only touch earlier days' documents).
  type Open = { id: number; customer?: number; vendor?: number; total: bigint; paid: bigint; date: string };
  const openInvoices: Open[] = [];
  const openBills: Open[] = [];
  const openJobs: { id: number; customer: number; date: string }[] = [];
  const today = todayIST();
  const first = addDays(today, -DAYS);
  const line = () => ({
    lineId: "", categoryId: pickOf(productCategories), description: "Sign board", hsnSac: "", width: "", height: "", qty: String(int(1, 4)), unit: "Nos",
    rate: String(int(500, 25000)), discount: "", gst: "18",
  });
  const total = async (table: "invoices" | "purchase_bills", id: number) =>
    BigInt((await db.execute<{ t: string }>(sql`select total_paise as t from ${sql.identifier(table)} where id = ${id}`))[0].t);
  const mode = () => pickOf(["cash", "upi", "bank"] as const);
  const moneyAccount = (m: "cash" | "upi" | "bank") => accounts[m === "bank" ? "bank_1" : m];
  let n = 0;

  for (let day = 0; day < DAYS; day++) {
    const date = addDays(first, day);
    const d = formatDate(date);
    const tasks: (() => Promise<unknown>)[] = [];
    // ~11 direct invoices (a tenth estimates) + ~2.7 jobs started, jobs invoiced after ~10 days → ~13.7 invoices a day.
    for (let i = howMany(11); i > 0; i--) {
      tasks.push(async () => {
        const customer = pickOf(customers);
        const id = await createInvoice(owner, {
          kind: rand() < 0.1 ? "estimate" : "tax", customerId: String(customer), date: d, terms: "", notes: "",
          lines: JSON.stringify(Array.from({ length: int(1, 3) }, line)),
        });
        await issueInvoice(owner, id);
        openInvoices.push({ id, customer, total: await total("invoices", id), paid: 0n, date });
      });
    }
    for (let i = howMany(2.74); i > 0; i--) {
      tasks.push(async () => {
        const customer = pickOf(customers);
        const id = await createJob(owner, {
          customerId: String(customer), date: d, siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "",
          lines: JSON.stringify([line()]),
        });
        openJobs.push({ id, customer, date });
      });
    }
    for (const job of openJobs.filter((j) => j.date <= addDays(date, -10)).slice(0, 4)) {
      openJobs.splice(openJobs.indexOf(job), 1);
      tasks.push(async () => {
        const id = await createInvoiceFromJobs(owner, [job.id], "tax");
        // The draft takes today's date: move it to this day, as if billed then (a draft posts nothing until Issue,
        // which dates its entry and due date from the invoice's date).
        await writeTx(owner, (tx) => tx.execute(sql`update invoices set date = ${date} where id = ${id} and status = 'draft'`));
        await issueInvoice(owner, id);
        openInvoices.push({ id, customer: job.customer, total: await total("invoices", id), paid: 0n, date });
      });
    }
    // ~11 receipts, each on a different open invoice from the last 90 days (most paid in full); paid prints add ~2.7.
    const payable = openInvoices.filter((o) => o.paid < o.total && o.date < date && o.date >= addDays(date, -90));
    for (let i = Math.min(howMany(11), payable.length); i > 0; i--) {
      const inv = payable.splice(Math.floor(rand() * payable.length), 1)[0];
      const open = inv.total - inv.paid;
      const amount = rand() < 0.75 ? open : (open * BigInt(int(20, 80))) / 100n;
      if (amount <= 0n) continue;
      inv.paid += amount;
      const m = mode();
      const rupees = `${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`;
      tasks.push(() =>
        createReceipt(owner, {
          customerId: String(inv.customer), date: d, amount: rupees, mode: m, moneyAccountId: moneyAccount(m), reference: "", chequeNo: "", chequeDate: "",
          receivedBy: "", notes: "", allocations: JSON.stringify([{ target: "invoice", id: String(inv.id), amount: rupees }]),
        }),
      );
    }
    // ~4.6 purchase bills (stock or expense lines), ~3.6 vendor payments, ~5.5 expenses.
    for (let i = howMany(4.6); i > 0; i--) {
      tasks.push(async () => {
        const vendor = pickOf(vendors);
        const stock = rand() < 0.5;
        const lines = Array.from({ length: int(1, 3) }, () =>
          stock
            ? { what: `item:${pickOf(items)}`, description: "", qty: String(int(5, 50)), rate: String(int(20, 900)), gst: "18", jobId: "" }
            : { what: `cat:${pickOf(spendCats).id}`, description: "Service", qty: "1", rate: String(int(300, 9000)), gst: "18", jobId: "" },
        );
        const { id } = await createPurchaseBill(owner, { vendorId: String(vendor), vendorBillNo: `B${++n}`, date: d, roundOff: "", notes: "", lines: JSON.stringify(lines) });
        openBills.push({ id: id!, vendor, total: await total("purchase_bills", id!), paid: 0n, date });
      });
    }
    const bills = openBills.filter((o) => o.paid < o.total && o.date < date);
    for (let i = Math.min(howMany(3.6), bills.length); i > 0; i--) {
      const bill = bills.splice(Math.floor(rand() * bills.length), 1)[0];
      const amount = bill.total - bill.paid;
      bill.paid = bill.total;
      const rupees = `${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`;
      const m = mode();
      tasks.push(() =>
        createVendorPayment(owner, {
          vendorId: String(bill.vendor), date: d, amount: rupees, mode: m, moneyAccountId: moneyAccount(m), reference: "", chequeNo: "", chequeDate: "", notes: "",
          allocations: JSON.stringify([{ id: String(bill.id), amount: rupees }]),
        }),
      );
    }
    for (let i = howMany(5.5); i > 0; i--) {
      const job = rand() < 0.2 && openJobs.length ? pickOf(openJobs) : null;
      tasks.push(() =>
        createExpense(owner, {
          date: d, categoryId: pickOf(spendCats).id, vendorId: "", jobId: job ? String(job.id) : "", amount: String(int(50, 5000)), mode: "cash",
          moneyAccountId: accounts.cash, notes: "",
        }),
      );
    }
    // ~2 stock issues to jobs in production, ~5.5 print jobs (a tenth on a job), ~2 follow-ups, a credit note now and then.
    for (let i = Math.min(howMany(2), openJobs.length); i > 0; i--) {
      const job = pickOf(openJobs);
      tasks.push(() =>
        createStockIssue(owner, { kind: "issue", jobId: String(job.id), date: d, notes: "", lines: JSON.stringify([{ itemId: String(pickOf(items)), qty: String(int(1, 10)) }]) }),
      );
    }
    for (let i = howMany(5.5); i > 0; i--) {
      const job = rand() < 0.1 && openJobs.length ? pickOf(openJobs) : null;
      const paid = rand();
      tasks.push(() =>
        createPrintJob(owner, {
          customerId: String(job ? job.customer : pickOf(customers)), newCustomerName: "", newCustomerMobile: "", jobId: job ? String(job.id) : "",
          fileName: `JOB_${day}_${i}.cdr`, filePath: `D:\\RADHE JOBS\\${day}\\JOB_${i}.cdr`, machineId: String(pickOf(machines)), printingTypeId: String(pickOf(types)),
          width: String(int(2, 12)), height: String(int(2, 8)), qty: String(int(1, 3)), rate: "",
          payment: job ? "" : paid < 0.5 ? "paid" : "unpaid", received: "", receiptMode: job || paid >= 0.5 ? "" : "cash", reprintOfId: "", notes: "",
          date: d, time: `${String(int(9, 19)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}`,
        }),
      );
    }
    for (let i = howMany(2); i > 0; i--) {
      const inv = pickOf(openInvoices.length ? openInvoices : [null]);
      if (!inv) break;
      tasks.push(() =>
        createFollowUp(owner, {
          customerId: String(inv.customer), invoiceId: String(inv.id), followUpDate: d, personId: pickOf(people), response: "Will pay next week",
          promiseDate: formatDate(addDays(date, 7)), expected: "1000", nextReminderDate: formatDate(addDays(date, 7)),
        }),
      );
    }
    if (rand() < 0.1 && openInvoices.length) {
      const inv = openInvoices[openInvoices.length - 1 - int(0, Math.min(50, openInvoices.length - 1))];
      if (inv.paid === 0n && inv.date < date) {
        inv.paid = inv.total; // keep it out of the receipts
        tasks.push(async () => {
          const [l] = await invoiceLinesLeft(db, "credit", inv.id);
          if (!l) return;
          const note = await createNote(owner, "credit", inv.id, { date: d, reason: "Rate corrected", notes: "", lines: JSON.stringify([{ invoiceLineId: String(l.id), qty: "", amount: "100" }]) });
          await issueNote(owner, "credit", note);
        });
      }
    }
    await pool(tasks);
    if (day % 30 === 0) console.log(`${d}: ${openInvoices.length} invoices, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
  const counts = await db.execute<Record<string, string>>(sql`
    select (select count(*) from customers) as customers, (select count(*) from invoices) as invoices, (select count(*) from receipts) as receipts,
           (select count(*) from purchase_bills) as purchase_bills, (select count(*) from vendor_payments) as vendor_payments,
           (select count(*) from expenses) as expenses, (select count(*) from print_jobs) as print_jobs, (select count(*) from jobs) as jobs,
           (select count(*) from stock_moves) as stock_moves, (select count(*) from journal_entries) as journal_entries,
           (select count(*) from journal_lines) as journal_lines, (select count(*) from allocations) as allocations,
           (select count(*) from audit_log) as audit_log`);
  console.log(`filled in ${((Date.now() - started) / 60000).toFixed(1)} min`, counts[0]);
  for (const { t } of await db.execute<{ t: string }>(sql`select tablename as t from pg_tables where schemaname = 'public'`)) {
    await db.execute(sql`analyze ${sql.identifier(t)}`);
  }
}

async function time() {
  const { db } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const { testOwner } = await import("./test-owner");
  const { loadDashboard } = await import("@/lib/dashboard");
  const { REPORT_INDEX } = await import("@/lib/reports");
  const { reportLoader } = await import("@/lib/exports");
  const { search } = await import("@/lib/search");
  const { outstanding } = await import("@/lib/outstanding");
  const { customerLedger } = await import("@/lib/statements");
  const { customerHistory } = await import("@/lib/customer-history");
  const { listInvoices } = await import("@/lib/invoices");
  const { listReceipts } = await import("@/lib/receipts");
  const { listCustomers } = await import("@/lib/customers");
  const { formatDate, todayIST } = await import("@/lib/dates");

  const owner = await testOwner();
  const rows: [string, number, number][] = [];
  const ms = async (fn: () => Promise<unknown>) => {
    const t = performance.now();
    await fn();
    return performance.now() - t;
  };
  /** First call (cold) and the median of three more (warm), in ms. */
  async function timed(label: string, fn: () => Promise<unknown>) {
    const cold = await ms(fn);
    const warm = [await ms(fn), await ms(fn), await ms(fn)].sort((a, b) => a - b)[1];
    rows.push([label, cold, warm]);
    console.log(`${label.padEnd(48)} ${cold.toFixed(0).padStart(6)} ms  ${warm.toFixed(0).padStart(6)} ms`);
  }
  console.log(`${"".padEnd(48)} ${"cold".padStart(9)}  ${"warm".padStart(9)}`);
  await timed("dashboard", () => loadDashboard(owner));
  const [busy] = await db.execute<{ id: string }>(sql`select customer_id as id from journal_lines where customer_id is not null group by 1 order by count(*) desc limit 1`);
  const all = { period: "custom", from: "01/04/2023", to: formatDate(todayIST()) };
  for (const r of REPORT_INDEX) {
    const load = reportLoader(r.name)!;
    for (const [label, base] of [["default", {}], ["3 years", all]] as const) {
      const q: Record<string, string> = { ...base };
      // Fill required picks (a ledger's party) with the busiest one, or the first option.
      const first = await load(owner, q);
      for (const p of first?.picks ?? []) {
        if (!p.value && p.options.length) q[p.name] = p.options.find(([v]) => v === busy.id)?.[0] ?? p.options[0][0];
      }
      await timed(`report ${r.n} ${r.name} (${label})`, () => load(owner, q));
    }
  }
  for (const q of ["shree", "RDS/25-26/42", "25000", "98000", "Konica"]) await timed(`search "${q}"`, () => search(owner, q));
  await timed("outstanding", () => outstanding());
  await timed("customer ledger (busiest, all entries)", () => customerLedger(Number(busy.id), { from: null, to: null }));
  await timed("customer history (busiest)", () => customerHistory(Number(busy.id)));
  await timed("list invoices (all rows, D60)", () => listInvoices());
  await timed("list receipts (all rows, D60)", () => listReceipts());
  await timed("list customers (all rows, D60)", () => listCustomers());
  const slow = rows.filter(([l, , w]) => (l === "dashboard" ? w > 1000 : l.startsWith("search") ? w > 300 : l.startsWith("report") ? w > 2000 : false));
  console.log(slow.length ? `OVER TARGET: ${slow.map(([l]) => l).join(", ")}` : "all targets met (dashboard < 1 s, reports < 2 s, search < 300 ms)");
}

async function main() {
  if (process.argv[2] !== "time") await fill();
  await time();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { db } = await import("@/db");
    await db.$client.end();
  });
