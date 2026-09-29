import { divRound, invoiceTotals, parseMoney, parsePercent, parseQty, type GstMode } from "@/lib/num";

// Purchase bill lines (A§2, D51), client-safe: the bill form reads them live with the same code the server saves
// with. A line is a stock item OR an expense category; qty × rate = taxable (no discount); GST per line; a job only on
// an expense line (a stock item reaches a job through Issue to Job, T21).

/** The form's text. what = "item:12" (stock item) or "cat:5" (expense category); jobId blank = none. */
export type PurchaseLineText = { what: string; description: string; qty: string; rate: string; gst: string; jobId: string };
export const PURCHASE_LINE_KEYS = ["what", "description", "qty", "rate", "gst", "jobId"] as const;

export type PurchaseLine = {
  itemId: number | null;
  categoryId: number | null;
  description: string | null;
  qtyMilli: bigint;
  ratePaise: bigint;
  gstBp: number;
  jobId: number | null;
};

/** Nothing typed on the line: skipped (a stray empty row doesn't block saving). */
export const blankLine = (t: PurchaseLineText) => !t.what && !t.qty.trim() && !t.rate.trim();

/** One line as typed → values; throws Error("Line n: …"). */
export function readPurchaseLine(t: PurchaseLineText, n: number): PurchaseLine {
  const fail = (message: string): never => {
    throw new Error(`Line ${n}: ${message}`);
  };
  const m = /^(item|cat):(\d+)$/.exec(t.what);
  if (!m) fail("pick a stock item or an expense category.");
  const [, kind, id] = m!;
  const description = t.description.trim() || null;
  if (description && description.length > 200) fail("keep the description under 200 characters.");
  let qtyMilli = 0n;
  let ratePaise = -1n;
  let gstBp = -1;
  try {
    qtyMilli = parseQty(t.qty);
  } catch {
    fail("enter the qty like 10 or 2.5.");
  }
  if (qtyMilli <= 0n) fail("the qty must be more than 0.");
  try {
    ratePaise = parseMoney(t.rate);
  } catch {
    fail("enter the rate like 1,250 or 99.50.");
  }
  if (ratePaise < 0n) fail("the rate can't be negative.");
  try {
    gstBp = parsePercent(t.gst);
  } catch {
    fail("enter the GST % (0 if none).");
  }
  if (gstBp < 0 || gstBp > 10000) fail("GST % is from 0 to 100.");
  const jobId = t.jobId ? Number(t.jobId) : null;
  if (jobId !== null && !Number.isSafeInteger(jobId)) fail("pick the job again.");
  if (jobId !== null && kind === "item") fail("a job goes on expense lines only; stock reaches a job through Issue to Job.");
  return {
    itemId: kind === "item" ? Number(id) : null,
    categoryId: kind === "cat" ? Number(id) : null,
    description,
    qtyMilli,
    ratePaise,
    gstBp,
    jobId,
  };
}

/** A purchase order line as typed (T22): a stock item; requestLineId = the material request line it came from. */
export type OrderLineText = { itemId: string; description: string; qty: string; rate: string; gst: string; requestLineId: string };
export const ORDER_LINE_KEYS = ["itemId", "description", "qty", "rate", "gst", "requestLineId"] as const;
export type OrderLine = PurchaseLine & { itemId: number; requestLineId: number | null };
export const blankOrderLine = (t: OrderLineText) => !t.itemId && !t.qty.trim() && !t.rate.trim();

/** One order line as typed → values (read like a bill's stock line); throws Error("Line n: …"). */
export function readOrderLine(t: OrderLineText, n: number): OrderLine {
  if (!t.itemId) throw new Error(`Line ${n}: pick the item.`);
  const l = readPurchaseLine({ what: `item:${t.itemId}`, description: t.description, qty: t.qty, rate: t.rate, gst: t.gst, jobId: "" }, n);
  const requestLineId = t.requestLineId ? Number(t.requestLineId) : null;
  if (requestLineId !== null && !Number.isSafeInteger(requestLineId)) throw new Error(`Line ${n}: reload the page.`);
  return { ...l, itemId: l.itemId!, requestLineId };
}

/** The line's taxable value: qty × rate, half-up to the paisa. */
export const taxableOf = (l: Pick<PurchaseLine, "qtyMilli" | "ratePaise">) => divRound(l.qtyMilli * l.ratePaise, 1000n);

/**
 * Bill totals (A§4): GST per line, then the round-off — to the nearest rupee, or `roundOff` as typed (±₹1 at most, to
 * match the vendor's total, D51).
 */
export function billTotals(lines: Pick<PurchaseLine, "qtyMilli" | "ratePaise" | "gstBp">[], mode: GstMode, roundOff: bigint | null = null) {
  const t = invoiceTotals(lines.map((l) => ({ qty: l.qtyMilli, rate: l.ratePaise, gstBp: l.gstBp })), mode);
  if (roundOff === null) return t;
  if (roundOff < -100n || roundOff > 100n) throw new Error("The round-off can be ₹1 either way at most.");
  const exact = t.total - t.roundOff;
  return { ...t, roundOff, total: exact + roundOff };
}
