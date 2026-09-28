import { UserError } from "@/lib/action";
import { bpText, divRound, invoiceTotals, milliText, moneyText, parseMoney, parsePercent, parseQty, type GstMode } from "@/lib/num";

// Sales lines (A§2 quotation_lines, A§4, D46) as typed → values, and their totals. Quotations, jobs and invoices all
// use these. Plain functions: the form runs them for live totals, the server again when saving. Client-safe.

/** Suggestions only: the unit is free text (D46). */
export const UNITS = ["Nos", "Sq Ft", "Rft", "Set"];

export const LINE_KEYS = [
  "lineId", "categoryId", "description", "hsnSac", "width", "height", "qty", "unit", "rate", "discount", "gst",
] as const;
/** A line as typed. lineId = the saved line it came from, so its links (job, quotation line) are kept. */
export type LineText = Record<(typeof LINE_KEYS)[number], string>;

export type Line = {
  lineId: number | null;
  categoryId: number;
  description: string | null;
  hsnSac: string | null; // null = the category's
  widthMilli: bigint | null; // feet, thousandths
  heightMilli: bigint | null;
  qtyMilli: bigint;
  unit: string;
  ratePaise: bigint;
  discountPaise: bigint;
  gstBp: number | null; // null = the category's
};

export const isSqFt = (unit: string) => /^sq\.?\s*ft$/i.test(unit.trim());

/** Board area: W × H ft (thousandths) → sq ft (thousandths), half-up. */
export const sqFt = (width: bigint, height: bigint) => divRound(width * height, 1000n);

/** "6 × 3 ft", or null without a size. */
export const sizeText = (width: bigint | null, height: bigint | null) =>
  width !== null && height !== null ? `${milliText(width)} × ${milliText(height)} ft` : null;

/** Line `n` (1-based) as typed → values. Throws a UserError naming the line. */
export function readLine(t: LineText, n: number): Line {
  const fail = (message: string): never => {
    throw new UserError(`Line ${n}: ${message}`, "lines");
  };
  const read = <T,>(text: string, parse: (s: string) => T, message: string): T => {
    try {
      return parse(text);
    } catch {
      return fail(message);
    }
  };

  const categoryId = Number(t.categoryId);
  if (!Number.isSafeInteger(categoryId) || categoryId < 1) fail("pick a category.");
  const size = (text: string) => {
    if (!text.trim()) return null;
    const v = read(text, parseQty, "a size is in feet, e.g. 6 or 2.5.");
    return v > 0n ? v : fail("a size must be more than 0.");
  };
  const [widthMilli, heightMilli] = [size(t.width), size(t.height)];
  if ((widthMilli === null) !== (heightMilli === null)) fail("enter both width and height, or neither.");

  const unit = t.unit.trim() || "Nos";
  if (unit.length > 20) fail("keep the unit short, e.g. Nos or Sq Ft.");
  let qtyMilli: bigint;
  if (t.qty.trim()) qtyMilli = read(t.qty, parseQty, "enter the qty, up to 3 decimals.");
  else if (isSqFt(unit) && widthMilli !== null && heightMilli !== null) qtyMilli = sqFt(widthMilli, heightMilli);
  else qtyMilli = fail("enter the qty.");
  if (qtyMilli <= 0n) fail("the qty must be more than 0.");

  const ratePaise = read(t.rate, parseMoney, "enter the rate, e.g. 1,250.50.");
  if (ratePaise < 0n) fail("the rate can't be negative.");
  const discountPaise = t.discount.trim() ? read(t.discount, parseMoney, "enter the discount in ₹, e.g. 500.") : 0n;
  if (discountPaise < 0n) fail("the discount can't be negative.");
  if (discountPaise > divRound(qtyMilli * ratePaise, 1000n)) fail("the discount is more than the line amount.");

  let gstBp: number | null = null;
  if (t.gst.trim()) {
    gstBp = read(t.gst, parsePercent, "enter GST % like 18 or 12.5.");
    if (gstBp < 0 || gstBp > 10000) fail("GST % is from 0 to 100.");
  }
  const hsnSac = t.hsnSac.replace(/\s/g, "") || null;
  if (hsnSac && !/^\d{4,8}$/.test(hsnSac)) fail("HSN / SAC is 4 to 8 digits.");
  const description = t.description.trim() || null;
  if (description && description.length > 500) fail("keep the description under 500 characters.");
  const lineId = t.lineId ? Number(t.lineId) : null;
  if (lineId !== null && !Number.isSafeInteger(lineId)) fail("reload the page and try again.");

  return { lineId, categoryId, description, hsnSac, widthMilli, heightMilli, qtyMilli, unit, ratePaise, discountPaise, gstBp };
}

/** A saved line back as form text. */
export function lineText(l: Omit<Line, "lineId"> & { id?: number }): LineText {
  return {
    lineId: l.id === undefined ? "" : String(l.id),
    categoryId: String(l.categoryId),
    description: l.description ?? "",
    hsnSac: l.hsnSac ?? "",
    width: l.widthMilli === null ? "" : milliText(l.widthMilli),
    height: l.heightMilli === null ? "" : milliText(l.heightMilli),
    qty: milliText(l.qtyMilli),
    unit: l.unit,
    rate: moneyText(l.ratePaise),
    discount: l.discountPaise ? moneyText(l.discountPaise) : "",
    gst: l.gstBp === null ? "" : bpText(l.gstBp),
  };
}

/** Same state → CGST + SGST, other state → IGST (A§4); an estimate has no GST (D18). */
export function gstMode(placeOfSupply: string, companyState: string, estimate = false): GstMode {
  if (estimate) return "estimate";
  return placeOfSupply === companyState ? "same_state" : "other_state";
}

type Priced = { qtyMilli: bigint; ratePaise: bigint; discountPaise: bigint; gstBp: number };

/** Per-line figures + totals with round-off, from num.ts only. */
export const lineTotals = (lines: Priced[], mode: GstMode) =>
  invoiceTotals(
    lines.map((l) => ({ qty: l.qtyMilli, rate: l.ratePaise, discount: l.discountPaise, gstBp: l.gstBp })),
    mode,
  );
