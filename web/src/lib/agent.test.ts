import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { GET as bootstrapRoute } from "@/app/api/agent/bootstrap/route";
import { POST as pairRoute } from "@/app/api/agent/pair/route";
import { POST as thumbnailRoute } from "@/app/api/agent/print-jobs/[id]/thumbnail/route";
import { POST as printJobsRoute } from "@/app/api/agent/print-jobs/route";
import { GET as reprintRoute } from "@/app/api/agent/reprint-check/route";
import { db } from "@/db";
import { attachments, auditLog, customers, pairingCodes, printDevices, printJobs, receipts } from "@/db/schema";
import { signedIn, testOwner, OWNER } from "@/db/test-owner";
import { createPairingCode, revokeDevice } from "@/lib/agent";
import { createCustomer } from "@/lib/customers";
import { createJob } from "@/lib/jobs";
import type { SessionUser } from "@/lib/permissions";
import { createPrintJob, printThumbnail, saveMachine, savePrintingType } from "@/lib/print-jobs";
import { saveBooks } from "@/lib/settings";
import { createUser, updateUser } from "@/lib/users";

// T39 (A§11, D64, docs/AGENT-API.md): pairing once only and within 10 minutes; every /api/agent/* call needs a live
// device token (a session cookie alone, an unknown or a revoked token → 401); bootstrap without cost rates; create is
// idempotent by client_uuid, also for copies arriving together; printed_at rules; quick-add by mobile; reprint check;
// thumbnails images only. Routes are called as the agent would, with Request objects.

let owner: SessionUser;
let operator: SessionUser; // production: any role may print at a machine (D64)
let accountant: SessionUser;
const ids: Record<string, number> = {};
let token = "";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const URL_BASE = "http://localhost:3000/api/agent";
const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const headers = new Headers(init.headers);
  const t = init.token === undefined ? token : init.token;
  if (t) headers.set("authorization", `Bearer ${t}`);
  return new Request(`${URL_BASE}${path}`, { ...init, headers });
};
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const pair = async (code: string, name = "PJ Front desk PC") => pairRoute(new Request(`${URL_BASE}/pair`, json({ code, name })));
const post = (body: unknown, t?: string | null) => printJobsRoute(call("/print-jobs", { ...json(body), token: t }), { params: Promise.resolve({}) });
const bootstrap = (t?: string | null, headers?: HeadersInit) => bootstrapRoute(call("/bootstrap", { token: t, headers }), { params: Promise.resolve({}) });
const thumb = (id: number, bytes: Uint8Array, t?: string | null) =>
  thumbnailRoute(call(`/print-jobs/${id}/thumbnail?name=front.png`, { method: "POST", body: bytes as BodyInit, token: t }), {
    params: Promise.resolve({ id: String(id) }),
  });

/** The popup's print: a new 6 × 3 ft × 2 sale at the machine's rate, unpaid. */
const print = (patch: Record<string, unknown> = {}) => ({
  client_uuid: randomUUID(),
  operator_user_id: operator.id,
  printed_at: new Date(Date.now() - 60_000).toISOString(),
  customer_id: ids.customer,
  job_id: null,
  file_name: "AG_FRONT_BOARD.cdr",
  file_path: "D:\\RADHE JOBS\\AG\\AG_FRONT_BOARD.cdr",
  machine_id: ids.machine,
  printing_type_id: ids.type,
  width: "6",
  height: "3",
  qty: "2",
  rate: null,
  payment: "unpaid",
  received: null,
  receipt_mode: null,
  ...patch,
});

beforeAll(async () => {
  owner = await testOwner();
  const user = async (username: string, role: SessionUser["role"]) => {
    const u = { name: username, username, role, canViewCost: role === "accountant" };
    return { ...u, id: await createUser(owner, { ...u, password: `${username}-pass-1` }) };
  };
  operator = await user("ag.operator", "production");
  accountant = await user("ag.acct", "accountant");
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const [category] = await db.execute<{ id: string }>(sql`select id from product_categories order by id limit 1`);
  ids.machine = await saveMachine(owner, null, { name: "AG Konica", printerNames: "KONICA-1", saleRate: "25", costRate: "12.34", active: true });
  ids.type = await savePrintingType(owner, null, { name: "AG Flex", categoryId: category.id, active: true });
  ids.customer = await createCustomer(owner, {
    name: "AG Shree Ganesh Signs", firmName: "", mobile: "+91 97250 33333", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
    creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
  });
  ids.job = await createJob(owner, {
    customerId: String(ids.customer), date: "01/10/2026", siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "",
    lines: JSON.stringify([{ lineId: "", categoryId: category.id, description: "Board", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate: "9,000", discount: "", gst: "18" }]),
  });
});

test("pairing: a code pairs one PC, once, within 10 minutes; only the token's SHA-256 is stored", async () => {
  const { code, expiresAt } = await createPairingCode(owner);
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
  await expect(createPairingCode(accountant)).rejects.toThrow("Not allowed"); // Settings → Devices is the owner's

  const res = await pair(code.toLowerCase().replace("-", " ")); // typed loosely: case and separator don't matter
  expect(res.status).toBe(201);
  const paired = (await res.json()) as { token: string; device: { id: number; name: string } };
  expect(paired.device.name).toBe("PJ Front desk PC");
  expect(Buffer.from(paired.token, "base64url").length).toBeGreaterThanOrEqual(32);
  token = paired.token;
  ids.device = paired.device.id;
  const [d] = await db.select().from(printDevices).where(eq(printDevices.id, ids.device));
  expect(d.tokenHash).toBe(sha256(token));
  expect(JSON.stringify(d)).not.toContain(token);
  const [c] = await db.select().from(pairingCodes).where(eq(pairingCodes.deviceId, ids.device));
  expect(c.usedAt).not.toBeNull();
  expect(c.codeHash).not.toContain(code.replace("-", ""));

  // Used once: never again. Older than 10 minutes: refused. Wrong: refused. No name: 400.
  expect((await pair(code)).status).toBe(401);
  const stale = await createPairingCode(owner, new Date(Date.now() - 11 * 60_000));
  expect((await pair(stale.code)).status).toBe(401);
  expect((await pair("ZZZZ-ZZZZ")).status).toBe(401);
  const fresh = await createPairingCode(owner);
  expect((await pairRoute(new Request(`${URL_BASE}/pair`, json({ code: fresh.code, name: " " })))).status).toBe(400);
  expect((await pairRoute(new Request(`${URL_BASE}/pair`, { method: "POST", body: "not json" }))).status).toBe(400);
  expect(await db.select().from(printDevices).where(eq(printDevices.name, "PJ Front desk PC"))).toHaveLength(1);
});

test("every other call needs the device token: a session cookie alone, an unknown or a revoked token → 401", async () => {
  const cookie = (await signedIn(OWNER.username, OWNER.password)).get("cookie")!;
  expect((await bootstrap(null, { cookie })).status).toBe(401);
  expect((await post(print(), null)).status).toBe(401);
  expect((await bootstrap("x".repeat(43))).status).toBe(401);
  expect((await bootstrap(`${token}x`)).status).toBe(401);
  const res = await bootstrapRoute(new Request(`${URL_BASE}/bootstrap`, { headers: { authorization: token } }), { params: Promise.resolve({}) });
  expect(res.status).toBe(401); // the "Bearer " scheme is required

  expect((await bootstrap()).status).toBe(200);
  const [d] = await db.select().from(printDevices).where(eq(printDevices.id, ids.device));
  expect(d.lastSeenAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);

  // A second PC, revoked: its token stops working at once, the first PC's doesn't.
  const other = (await (await pair((await createPairingCode(owner)).code, "PJ Back office")).json()) as { token: string; device: { id: number } };
  expect((await bootstrap(other.token)).status).toBe(200);
  await revokeDevice(owner, other.device.id);
  expect((await bootstrap(other.token)).status).toBe(401);
  expect((await post(print(), other.token)).status).toBe(401);
  expect((await bootstrap()).status).toBe(200);
  await expect(revokeDevice(accountant, ids.device)).rejects.toThrow("Not allowed");
});

test("bootstrap: active customers, open jobs, machines with the sale rate only (never the cost rate), types, operators", async () => {
  const b = (await (await bootstrap()).json()) as Record<string, Record<string, unknown>[]> & { device: { id: number } };
  expect(b.device.id).toBe(ids.device);
  const machine = b.machines.find((m) => m.id === ids.machine)!;
  expect(machine).toEqual({ id: ids.machine, name: "AG Konica", printer_names: ["KONICA-1"], sale_rate: "25.00" });
  // D68: keys, not free text — other files' rows (a user named "PB nocost") ride in the same payload.
  for (const m of b.machines) expect(Object.keys(m).sort()).toEqual(["id", "name", "printer_names", "sale_rate"]);
  expect(b.customers.find((c) => c.id === ids.customer)).toEqual({ id: ids.customer, name: "AG Shree Ganesh Signs", firm_name: null, mobile: "+91 97250 33333" });
  expect(b.jobs.find((j) => j.id === ids.job)).toEqual({ id: ids.job, number: expect.stringMatching(/^RDS-/), customer_id: ids.customer, status: "In Production" });
  expect(Object.keys(b.printing_types[0]).sort()).toEqual(["id", "name"]);
  expect(b.operators.find((o) => o.id === operator.id)).toEqual({ id: operator.id, name: "ag.operator" });
  for (const j of b.jobs) expect(Object.keys(j).sort()).toEqual(["customer_id", "id", "number", "status"]);
});

test("create: like the web form, with the device and the operator (any role) as the audit user; printed_at skips the backdate gate", async () => {
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString().replace("Z", "+00:00");
  const body = print({ printed_at: fiveDaysAgo, payment: "unpaid", received: "500", receipt_mode: "upi" });
  const res = await post(body);
  expect(res.status).toBe(201);
  const saved = (await res.json()) as { id: number; number: string; customer_id: number; duplicate: boolean };
  expect(saved).toEqual({ id: expect.any(Number), number: expect.stringMatching(/^PJ\/\d\d-\d\d\/\d{5}$/), customer_id: ids.customer, duplicate: false });
  const [pj] = await db.select().from(printJobs).where(eq(printJobs.id, saved.id));
  expect(pj).toMatchObject({ deviceId: ids.device, clientUuid: body.client_uuid, operatorUserId: operator.id, sqftMilli: 36000n, amountPaise: 900_00n, mode: "sale" });
  expect(pj.printedAt.toISOString()).toBe(new Date(fiveDaysAgo).toISOString());
  const [log] = await db.select().from(auditLog).where(and(eq(auditLog.tableName, "print_jobs"), eq(auditLog.rowId, String(saved.id))));
  expect(log.userId).toBe(operator.id);
  // The ₹500 taken at the machine: a UPI receipt received by the operator, dated the print's day.
  const [r] = await db.select().from(receipts).where(eq(receipts.notes, `Taken at print ${saved.number}`));
  expect(r).toMatchObject({ amountPaise: 500_00n, mode: "upi", receivedBy: operator.id, date: pj.date });

  // On an existing job: costed by the server; a rate sent for it is refused.
  const onJob = await post(print({ job_id: ids.job, payment: null }));
  expect(onJob.status).toBe(201);
  const [cost] = await db.select().from(printJobs).where(eq(printJobs.id, ((await onJob.json()) as { id: number }).id));
  expect(cost).toMatchObject({ mode: "job_cost", ratePaise: 1234n, amountPaise: 444_24n }); // 36 sq ft × ₹12.34
  expect((await post(print({ job_id: ids.job, payment: null, rate: "5" }))).status).toBe(400);
  // D66: a machine with no cost rate never refuses the print: saved with its cost pending.
  const bare = await saveMachine(owner, null, { name: "AG Bare", printerNames: "BARE-1", saleRate: "25", costRate: "", active: true });
  const pending = await post(print({ job_id: ids.job, payment: null, machine_id: bare }));
  expect(pending.status).toBe(201);
  const [p] = await db.select().from(printJobs).where(eq(printJobs.id, ((await pending.json()) as { id: number }).id));
  expect(p).toMatchObject({ mode: "job_cost", ratePaise: null, amountPaise: null });
});

test("the same client_uuid twice — one after the other, or three at once — saves one print job and one receipt", async () => {
  const body = print({ payment: "paid", receipt_mode: "cash" });
  const first = await post(body);
  const again = await post(body);
  expect([first.status, again.status]).toEqual([201, 200]);
  const [a, b] = (await Promise.all([first.json(), again.json()])) as { id: number; number: string; duplicate: boolean }[];
  expect([b.id, b.duplicate, a.duplicate]).toEqual([a.id, true, false]);

  const together = print({ payment: "paid", receipt_mode: "cash" });
  const results = await Promise.all([post(together), post(together), post(together)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
  const bodies = (await Promise.all(results.map((r) => r.json()))) as { id: number; number: string }[];
  expect(new Set(bodies.map((x) => x.id)).size).toBe(1);
  for (const uuid of [body.client_uuid, together.client_uuid]) {
    expect(await db.select().from(printJobs).where(eq(printJobs.clientUuid, uuid))).toHaveLength(1);
  }
  for (const number of [a.number, bodies[0].number]) {
    expect(await db.select().from(receipts).where(eq(receipts.notes, `Taken at print ${number}`))).toHaveLength(1);
  }
});

test("everything sent is checked: printed_at, operator, decimals as text, ids, one customer", async () => {
  const bad = async (patch: Record<string, unknown>, field: string) => {
    const res = await post(print(patch));
    expect(res.status, field).toBe(400);
    expect(((await res.json()) as { field?: string }).field, JSON.stringify(patch)).toBe(field);
  };
  await bad({ printed_at: new Date(Date.now() + 86_400_000).toISOString() }, "printed_at"); // the future
  await bad({ printed_at: "2026-03-31T10:00:00+05:30" }, "printed_at"); // before the books start (01/04/2026)
  await bad({ printed_at: "2026-10-02 10:00" }, "printed_at"); // no offset
  await bad({ client_uuid: "not-a-uuid" }, "client_uuid");
  await bad({ operator_user_id: "nobody" }, "operator_user_id");
  await bad({ width: 6 }, "width"); // a JSON number: decimals travel as text
  await bad({ qty: "0" }, "qty");
  await bad({ machine_id: 1.5 }, "machine_id");
  await bad({ machine_id: 999999 }, "machine_id");
  await bad({ customer_id: null }, "customer_id");
  await bad({ new_customer: { name: "X", mobile: "9999999999" } }, "customer_id"); // both
  await bad({ payment: "free" }, "payment");
  const disabled = await createUser(owner, { name: "ag.gone", username: "ag.gone", role: "production", canViewCost: false, password: "ag.gone-pass-1" });
  await updateUser(owner, disabled, { active: false });
  await bad({ operator_user_id: disabled }, "operator_user_id");
  expect((await printJobsRoute(call("/print-jobs", { method: "POST", body: "[1,2]" }), { params: Promise.resolve({}) })).status).toBe(400);
});

test("quick-add (D64): a new name + mobile makes the customer in the same call; an existing mobile reuses that customer", async () => {
  const existing = await post(print({ customer_id: null, new_customer: { name: "AG Ganesh bhai", mobile: "9725033333" } }));
  expect(((await existing.json()) as { customer_id: number }).customer_id).toBe(ids.customer);
  const fresh = await post(print({ customer_id: null, new_customer: { name: "AG Walk-in Mehul", mobile: "98980 44444" } }));
  const { customer_id } = (await fresh.json()) as { customer_id: number };
  const [c] = await db.select().from(customers).where(eq(customers.id, customer_id));
  expect(c).toMatchObject({ name: "AG Walk-in Mehul", mobile: "98980 44444", stateCode: "24", gstin: null });
  expect(await db.select().from(customers).where(eq(customers.name, "AG Ganesh bhai"))).toHaveLength(0);
});

test("reprint check: the latest print jobs of the same file, by full path or name (case ignored); no amounts", async () => {
  const res = await reprintRoute(call(`/reprint-check?path=${encodeURIComponent("d:\\radhe jobs\\ag\\ag_front_board.CDR")}`), { params: Promise.resolve({}) });
  const { matches } = (await res.json()) as { matches: Record<string, unknown>[] };
  expect(matches.length).toBeGreaterThan(0);
  expect(matches.length).toBeLessThanOrEqual(5);
  expect(matches.every((m) => m.file_name === "AG_FRONT_BOARD.cdr" && m.width === "6" && m.height === "3")).toBe(true);
  expect(matches[0]).toMatchObject({ customer: { name: "AG Walk-in Mehul" } }); // newest first (the quick-add test's)
  expect(matches.every((m) => !("amount" in m))).toBe(true);
  expect(matches.find((m) => m.job !== null)?.rate ?? null).toBeNull(); // a print on a job: no rate (its cost)
  const byName = (await (await reprintRoute(call("/reprint-check?name=ag_front_board.cdr"), { params: Promise.resolve({}) })).json()) as { matches: unknown[] };
  expect(byName.matches.length).toBeGreaterThan(0);
  expect((await reprintRoute(call("/reprint-check"), { params: Promise.resolve({}) })).status).toBe(400);
});

test("thumbnail: an image (sniffed, ≤ 4 MB) becomes the print_thumbnail attachment once; a wrong type is refused", async () => {
  const saved = (await (await post(print())).json()) as { id: number };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(7)]);
  const pdf = new TextEncoder().encode("%PDF-1.7 not an image");
  expect((await thumb(saved.id, pdf)).status).toBe(415);
  expect((await thumb(saved.id, new TextEncoder().encode("MZ\x90\x00 an exe"))).status).toBe(415);
  expect((await thumb(saved.id, new Uint8Array(4 * 1024 * 1024 + 1).fill(0xff))).status).toBe(413);
  const first = await thumb(saved.id, png);
  expect(first.status).toBe(201);
  const { id } = (await first.json()) as { id: number };
  expect((await thumb(saved.id, png)).status).toBe(200); // a resend: the first one stays, no second file
  const [a] = await db.select().from(attachments).where(eq(attachments.id, id));
  expect(a).toMatchObject({ entityType: "print_job", entityId: saved.id, kind: "print_thumbnail", mime: "image/png", createdBy: operator.id, fileName: "front.png" });
  expect((await printThumbnail(saved.id))?.id).toBe(id);
  // Only a print job this device sent: not one from the web form, not an unknown one.
  const { id: web } = await createPrintJob(owner, {
    customerId: String(ids.customer), newCustomerName: "", newCustomerMobile: "", jobId: "", fileName: "WEB.pdf", filePath: "", machineId: String(ids.machine),
    printingTypeId: String(ids.type), width: "1", height: "1", qty: "1", rate: "", payment: "credit", received: "", receiptMode: "", reprintOfId: "", notes: "",
    date: "01/10/2026", time: "10:00",
  });
  expect((await thumb(web!, png)).status).toBe(404);
  expect((await thumb(999999, png)).status).toBe(404);
});
