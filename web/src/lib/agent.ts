import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db, writeTx, type Tx } from "@/db";
import { attachments, customers, jobs, machines, pairingCodes, printDevices, printingTypes, printJobs, users } from "@/db/schema";
import { UserError } from "@/lib/action";
import { MAX_UPLOAD_BYTES } from "@/lib/attachment-kinds";
import { saveThumbnail, sniffType } from "@/lib/attachments";
import { JOB_STATUS, PRODUCTION_STATUSES } from "@/lib/jobs";
import { milliText, moneyText } from "@/lib/num";
import { can, type SessionUser } from "@/lib/permissions";
import { CLOCK_SKEW_MS, insertPrintJob, type PrintJobInput } from "@/lib/print-jobs";

// The print agent's side of the CRM (A§11, D64, T39; docs/AGENT-API.md). A PC pairs once with a one-time code the
// owner makes in Settings → Devices and gets a device token (32 random bytes, shown once; only its SHA-256 is kept).
// Every other /api/agent/* call carries "Authorization: Bearer <token>" — never a user session. What the agent sends
// is untrusted: every field is checked here, decimals arrive as text (never JSON numbers, so never floats), and each
// call names its operator, an active CRM user who becomes the audit user. Nothing sent back carries a cost rate.

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// ---- Pairing and devices (owner)

/** Codes the owner reads out or types: no 0 / O / 1 / I. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_MINUTES = 10;

/** Owner: a one-time pairing code, valid 10 minutes ("ABCD-EFGH"). Only its hash is stored, so it is shown once. */
export async function createPairingCode(actor: SessionUser, now = new Date()) {
  if (!can(actor, "devices", "create")) throw new Error("Not allowed");
  const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  const expiresAt = new Date(now.getTime() + PAIRING_MINUTES * 60_000);
  await writeTx(actor, (tx) => tx.insert(pairingCodes).values({ codeHash: sha256(raw), expiresAt, createdBy: actor.id }));
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
}

/**
 * POST /api/agent/pair: a live code (unused, under 10 minutes old) + the PC's name → a new device and its token,
 * returned this once. The code is used up in the same transaction, so it pairs one device only. null = wrong, used or
 * expired. The device is audited as made by the owner who made the code.
 */
export async function pairDevice(input: { code?: unknown; name?: unknown }, now = new Date()) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100) throw new UserError("Send the PC's name (up to 100 characters).", "name");
  const code = typeof input.code === "string" ? input.code.toUpperCase().replace(/[\s-]/g, "") : "";
  if (!/^[A-Z0-9]{8}$/.test(code)) return null;
  const [found] = await db.select().from(pairingCodes).where(eq(pairingCodes.codeHash, sha256(code)));
  if (!found) return null;
  return writeTx({ id: found.createdBy }, async (tx) => {
    const [c] = await tx.select().from(pairingCodes).where(eq(pairingCodes.id, found.id)).for("update");
    if (c.usedAt || c.expiresAt <= now) return null;
    const token = randomBytes(32).toString("base64url");
    const [device] = await tx.insert(printDevices).values({ name, tokenHash: sha256(token), createdBy: c.createdBy }).returning();
    await tx.update(pairingCodes).set({ usedAt: now, deviceId: device.id }).where(eq(pairingCodes.id, c.id));
    return { token, device: { id: device.id, name: device.name } };
  });
}

export type Device = typeof printDevices.$inferSelect;

/**
 * The device behind "Authorization: Bearer <token>", or null — no header, an unknown or a revoked token (the route
 * answers 401). A session cookie is never looked at. Stamps last_seen_at, at most once a minute.
 */
export async function deviceFrom(request: Request): Promise<Device | null> {
  const m = /^Bearer ([A-Za-z0-9_-]{43,200})$/.exec(request.headers.get("authorization") ?? "");
  if (!m) return null;
  const [device] = await db.select().from(printDevices).where(eq(printDevices.tokenHash, sha256(m[1])));
  if (!device || device.revokedAt) return null;
  if (!device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > 60_000) {
    await writeTx(null, (tx) => tx.update(printDevices).set({ lastSeenAt: new Date() }).where(eq(printDevices.id, device.id)));
  }
  return device;
}

/** Settings → Devices: every device, newest first (never the token hash). */
export async function listDevices(actor: SessionUser) {
  if (!can(actor, "devices", "view")) throw new Error("Not allowed");
  return db
    .select({ id: printDevices.id, name: printDevices.name, createdAt: printDevices.createdAt, lastSeenAt: printDevices.lastSeenAt, revokedAt: printDevices.revokedAt })
    .from(printDevices)
    .orderBy(desc(printDevices.id));
}

async function lockDevice(actor: SessionUser, id: number, fn: (tx: Tx, device: Device) => Promise<unknown>) {
  if (!can(actor, "devices", "edit")) throw new Error("Not allowed");
  await writeTx(actor, async (tx) => {
    const [device] = Number.isSafeInteger(id) ? await tx.select().from(printDevices).where(eq(printDevices.id, id)).for("update") : [];
    if (!device) throw new UserError("That device doesn't exist.");
    await fn(tx, device);
  });
}

export async function renameDevice(actor: SessionUser, id: number, nameInput: string) {
  const name = nameInput.trim();
  if (!name || name.length > 100) throw new UserError("Enter a name (up to 100 characters).", "name");
  await lockDevice(actor, id, (tx) => tx.update(printDevices).set({ name }).where(eq(printDevices.id, id)));
}

/** Its token stops working at once; the device stays listed (revoked). Pair again for a new token. */
export async function revokeDevice(actor: SessionUser, id: number) {
  await lockDevice(actor, id, async (tx, device) => {
    if (device.revokedAt) throw new UserError("This device is already revoked.");
    await tx.update(printDevices).set({ revokedAt: new Date() }).where(eq(printDevices.id, id));
  });
}

// ---- What the agent reads

/**
 * GET /api/agent/bootstrap (D64): active customers (id, name, firm, mobile), open jobs (id, number, customer — no
 * money), active machines (id, name, printer names, sale rate — never the cost rate), active printing types and the
 * operators (active users: id, name). Money as rupee text ("25.00").
 */
export async function bootstrap(device: Device) {
  const [customerRows, jobRows, machineRows, typeRows, operatorRows] = await Promise.all([
    db
      .select({ id: customers.id, name: customers.name, firm_name: customers.firmName, mobile: customers.mobile })
      .from(customers)
      .where(eq(customers.active, true))
      .orderBy(asc(customers.name)),
    db
      .select({ id: jobs.id, number: jobs.number, customer_id: jobs.customerId, status: jobs.status })
      .from(jobs)
      .where(inArray(jobs.status, [...PRODUCTION_STATUSES]))
      .orderBy(desc(jobs.id)),
    db
      .select({ id: machines.id, name: machines.name, printerNames: machines.printerNames, saleRatePaise: machines.saleRatePaise })
      .from(machines)
      .where(eq(machines.active, true))
      .orderBy(asc(machines.name)),
    db.select({ id: printingTypes.id, name: printingTypes.name }).from(printingTypes).where(eq(printingTypes.active, true)).orderBy(asc(printingTypes.name)),
    db.select({ id: users.id, name: users.name }).from(users).where(eq(users.active, true)).orderBy(asc(users.name)),
  ]);
  return {
    server_time: new Date().toISOString(),
    device: { id: device.id, name: device.name },
    customers: customerRows,
    jobs: jobRows.map((j) => ({ id: j.id, number: j.number, customer_id: j.customer_id, status: JOB_STATUS[j.status] })),
    machines: machineRows.map((m) => ({
      id: m.id,
      name: m.name,
      printer_names: m.printerNames,
      sale_rate: m.saleRatePaise === null ? null : moneyText(m.saleRatePaise),
    })),
    printing_types: typeRows,
    operators: operatorRows,
  };
}

/**
 * GET /api/agent/reprint-check?path=&name= (P8): the latest 5 live print jobs of that file — the same full path, or
 * the same file name (case ignored, as Windows does) — so the popup can ask "New or Reprint?". No money but a sale
 * print's rate (what the popup would fill in again); a print on a job is costed by the server.
 */
export async function reprintCheck(pathInput: string | null, nameInput: string | null) {
  const path = pathInput?.trim().slice(0, 1000) || null;
  const name = nameInput?.trim().slice(0, 260) || null;
  if (!path && !name) throw new UserError("Send path or name.", "path");
  const rows = await db
    .select({ pj: printJobs, customer: customers.name, job: jobs.number })
    .from(printJobs)
    .innerJoin(customers, eq(customers.id, printJobs.customerId))
    .leftJoin(jobs, eq(jobs.id, printJobs.jobId))
    .where(
      and(
        eq(printJobs.status, "active"),
        or(
          path ? sql`lower(${printJobs.filePath}) = lower(${path})` : undefined,
          name ? sql`lower(${printJobs.fileName}) = lower(${name})` : undefined,
        ),
      ),
    )
    .orderBy(desc(printJobs.printedAt), desc(printJobs.id))
    .limit(5);
  return {
    matches: rows.map(({ pj, customer, job }) => ({
      id: pj.id,
      number: pj.number,
      printed_at: pj.printedAt.toISOString(),
      customer: { id: pj.customerId, name: customer },
      job: pj.jobId === null ? null : { id: pj.jobId, number: job },
      file_name: pj.fileName,
      file_path: pj.filePath,
      machine_id: pj.machineId,
      printing_type_id: pj.printingTypeId,
      width: milliText(pj.widthMilli),
      height: milliText(pj.heightMilli),
      qty: milliText(pj.qtyMilli),
      rate: pj.mode === "sale" && pj.ratePaise !== null ? moneyText(pj.ratePaise) : null,
    })),
  };
}

// ---- What the agent sends

/** A request the agent got wrong: answered with `status` (400 unless said) and the message (+ the field, if any). */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly field?: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Wraps an /api/agent/* handler: 401 unless the request carries a live device token (a session cookie alone never
 * works); an AgentError → its status, a UserError (a field of the print) → 400, as { error, field? }.
 */
export function agentRoute<C>(handler: (device: Device, request: Request, ctx: C) => Promise<Response>) {
  return async (request: Request, ctx: C): Promise<Response> => {
    const device = await deviceFrom(request);
    if (!device) return Response.json({ error: "Not paired: send this device's token as Authorization: Bearer <token>." }, { status: 401 });
    try {
      return await handler(device, request, ctx);
    } catch (e) {
      return failure(e);
    }
  };
}

/** UserError / AgentError → a JSON answer; anything else is a bug and still throws (500). */
export function failure(e: unknown): Response {
  if (e instanceof AgentError) return Response.json({ error: e.message, ...(e.field ? { field: e.field } : {}) }, { status: e.status });
  if (e instanceof UserError) return Response.json({ error: e.message, ...(e.field ? { field: e.field } : {}) }, { status: 400 });
  throw e;
}

/** The JSON body, at most 64 KB. */
export async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > 64 * 1024) throw new AgentError("The request is too big.", undefined, 413);
  const text = await request.text();
  if (text.length > 64 * 1024) throw new AgentError("The request is too big.", undefined, 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentError("Send a JSON object.");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ISO 8601 with its offset (the PC's local time, e.g. +05:30) or Z; never a bare local time.
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})$/;

/** The create body → the web form's input (text fields) + who, when and the idempotency key. */
function readCreate(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AgentError("Send a JSON object.");
  const b = body as Record<string, unknown>;
  const text = (key: string, required = false): string => {
    const v = b[key];
    if (v === undefined || v === null || v === "") {
      if (required) throw new AgentError(`${key} is required.`, key);
      return "";
    }
    if (typeof v !== "string") throw new AgentError(`${key} must be text${["width", "height", "qty", "rate", "received"].includes(key) ? ' (decimals as text, e.g. "2.5")' : ""}.`, key);
    return v;
  };
  const id = (key: string, required = false): string => {
    const v = b[key];
    if (v === undefined || v === null || v === "") {
      if (required) throw new AgentError(`${key} is required.`, key);
      return "";
    }
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) throw new AgentError(`${key} must be a positive whole number.`, key);
    return String(n);
  };

  const clientUuid = text("client_uuid", true).toLowerCase();
  if (!UUID.test(clientUuid)) throw new AgentError("client_uuid must be a UUID.", "client_uuid");
  const operatorId = text("operator_user_id", true);
  const at = text("printed_at", true);
  const printedAt = new Date(at);
  if (!MOMENT.test(at) || Number.isNaN(printedAt.getTime())) {
    throw new AgentError("printed_at must be an ISO 8601 time with its offset, e.g. 2026-10-02T14:35:00+05:30.", "printed_at");
  }

  let newCustomer = { name: "", mobile: "" };
  const nc = b.new_customer;
  if (nc !== undefined && nc !== null) {
    if (typeof nc !== "object" || Array.isArray(nc)) throw new AgentError("new_customer must be { name, mobile }.", "new_customer");
    const { name, mobile } = nc as Record<string, unknown>;
    if (typeof name !== "string" || typeof mobile !== "string") throw new AgentError("new_customer needs name and mobile as text.", "new_customer");
    newCustomer = { name, mobile };
  }
  const customerId = id("customer_id");
  if (!customerId === !newCustomer.name) throw new AgentError("Send customer_id or new_customer (one of them).", "customer_id");

  const payment = text("payment");
  const input: PrintJobInput = {
    customerId,
    newCustomerName: newCustomer.name,
    newCustomerMobile: newCustomer.mobile,
    jobId: id("job_id"),
    fileName: text("file_name", true),
    filePath: text("file_path"),
    machineId: id("machine_id", true),
    printingTypeId: id("printing_type_id", true),
    width: text("width", true),
    height: text("height", true),
    qty: text("qty", true),
    rate: text("rate"),
    payment,
    received: text("received"),
    receiptMode: text("receipt_mode"),
    reprintOfId: id("reprint_of_id"),
    notes: text("notes"),
  };
  return { input, clientUuid, operatorId, printedAt };
}

/** The web form's field names (UserError.field from insertPrintJob) → the JSON keys the agent sent. */
const FIELD: Record<string, string> = {
  customerId: "customer_id",
  newCustomerName: "new_customer",
  newCustomerMobile: "new_customer",
  jobId: "job_id",
  fileName: "file_name",
  filePath: "file_path",
  machineId: "machine_id",
  printingTypeId: "printing_type_id",
  receiptMode: "receipt_mode",
  reprintOfId: "reprint_of_id",
  date: "printed_at",
  time: "printed_at",
};

/** What a saved print job answers (never an amount: a print on a job is a cost). */
const answer = (row: { id: number; number: string; customerId: number }, duplicate: boolean) => ({
  id: row.id,
  number: row.number,
  customer_id: row.customerId,
  duplicate,
});

/**
 * POST /api/agent/print-jobs: saves the popup's print exactly like the web form (insertPrintJob: quick-add customer,
 * new / existing job, rates on the server, the receipt for money taken) in one transaction, with the device and its
 * client_uuid. The same client_uuid again — a retry, or a copy arriving at the same moment — returns the first one
 * (duplicate: true) and saves nothing. printed_at (the PC's clock, maybe hours old from the offline queue) skips the
 * backdate gate but not the books start date, and can't be in the future. The operator must be an active user; they
 * are the audit user. UserError (a field) / AgentError (the request) → 400 in the route.
 */
export async function createFromAgent(device: Device, body: unknown) {
  const { input, clientUuid, operatorId, printedAt } = readCreate(body);
  const [operator] = await db.select({ id: users.id, active: users.active }).from(users).where(eq(users.id, operatorId));
  if (!operator?.active) throw new AgentError("operator_user_id is not an active CRM user.", "operator_user_id");
  if (printedAt.getTime() > Date.now() + CLOCK_SKEW_MS) throw new AgentError("printed_at is in the future: check the PC's clock.", "printed_at");

  const existing = async (q: Tx | typeof db) =>
    (await q.select({ id: printJobs.id, number: printJobs.number, customerId: printJobs.customerId }).from(printJobs).where(eq(printJobs.clientUuid, clientUuid)))[0];
  try {
    return await writeTx(operator, async (tx) => {
      // Two copies at once queue here; the second then finds the first (committed) one.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`print-job:${clientUuid}`}))`);
      const first = await existing(tx);
      if (first) return answer(first, true);
      const saved = await insertPrintJob(tx, input, { by: operator, printedAt, deviceId: device.id, clientUuid });
      return answer(saved, false);
    });
  } catch (e) {
    if (e instanceof UserError) throw new AgentError(e.message, e.field && (FIELD[e.field] ?? e.field));
    // Belt and braces: the unique client_uuid still decides if the lock was ever bypassed.
    const first = (e as { code?: string }).code === "23505" ? await existing(db) : undefined;
    if (first) return answer(first, true);
    throw e;
  }
}

/**
 * POST /api/agent/print-jobs/<id>/thumbnail: the print's preview image (JPEG / PNG / WebP, 4 MB at most, sniffed) as
 * its print_thumbnail attachment, saved by the print job's operator. Only for a print job this device sent; one per
 * print job (a resend returns the first, duplicate: true). null = no such print job of this device.
 */
export async function thumbnailFromAgent(device: Device, printJobId: number, fileName: string, bytes: Uint8Array) {
  const [pj] = Number.isSafeInteger(printJobId)
    ? await db.select().from(printJobs).where(and(eq(printJobs.id, printJobId), eq(printJobs.deviceId, device.id)))
    : [];
  if (!pj) return null;
  if (bytes.length > MAX_UPLOAD_BYTES) throw new AgentError("A thumbnail can be 4 MB at most.", undefined, 413);
  if (!sniffType(bytes)?.startsWith("image/")) throw new AgentError("A thumbnail must be a JPEG, PNG or WebP image.", undefined, 415);
  const [first] = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.entityType, "print_job"), eq(attachments.entityId, pj.id), eq(attachments.kind, "print_thumbnail")))
    .limit(1);
  if (first) return { id: first.id, duplicate: true };
  const row = await saveThumbnail({ id: pj.operatorUserId }, pj.id, fileName || `${pj.number}.jpg`, bytes);
  return { id: row.id, duplicate: false };
}
