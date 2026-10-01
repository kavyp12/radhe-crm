// Money = bigint paise · qty/size = bigint thousandths · GST rate = basis points (1800 = 18%).
// No floats in here (hard rule 1, D13, D30).

/** n ÷ d rounded half away from zero (49.5 → 50, −49.5 → −50), so reversals mirror the originals. */
export function divRound(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("divRound: divisor must be positive");
  const q = (2n * (n < 0n ? -n : n) + d) / (2n * d);
  return n < 0n ? -q : q;
}

// Integer part is plain digits or comma groups ending in 3 digits (1,00,000 · 100,000),
// so a decimal-comma typo like "12,5" is rejected instead of being read as 125.
const NUMBER = /^(-?)(\d+|\d{1,3}(?:,\d{2,3})*,\d{3})(?:\.(\d+))?$/;

function parseFixed(input: string, decimals: number, what: string): bigint {
  const m = NUMBER.exec(input.trim());
  if (!m) throw new Error(`Invalid ${what}: "${input}"`);
  const [, minus, int, frac = ""] = m;
  if (frac.length > decimals) throw new Error(`Invalid ${what}: "${input}" (max ${decimals} decimals)`);
  const v = BigInt(int.replaceAll(",", "") + frac.padEnd(decimals, "0"));
  return minus ? -v : v;
}

/** "1,00,000.50" → 10000050n paise. Throws on empty, junk or more than 2 decimals (never rounds). */
export const parseMoney = (input: string) => parseFixed(input, 2, "amount");
/** "12.5" → 12500n thousandths. Throws on empty, junk or more than 3 decimals (never rounds). */
export const parseQty = (input: string) => parseFixed(input, 3, "quantity");
/** "18" / "12.5" (%) → basis points (1800 / 1250). Throws on empty, junk or more than 2 decimals. */
export const parsePercent = (input: string) => Number(parseFixed(input, 2, "percentage"));

/** Thousandths as plain text, no trailing zeros: 12500n → "12.5", 3000n → "3", -250n → "-0.25". */
export function milliText(milli: bigint): string {
  const a = milli < 0n ? -milli : milli;
  const fraction = String(a % 1000n).padStart(3, "0").replace(/0+$/, "");
  return `${milli < 0n ? "-" : ""}${a / 1000n}${fraction ? `.${fraction}` : ""}`;
}

const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

/** Paise as plain form text that parseMoney reads back: 123450n → "1234.50", -5n → "-0.05". */
export function moneyText(paise: bigint): string {
  const a = paise < 0n ? -paise : paise;
  return `${paise < 0n ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
}

/** 10000000n → "₹1,00,000.00" · -123450n → "-₹1,234.50". Intl gets an exact decimal string, never a float. */
export function formatMoney(paise: bigint): string {
  return INR.format(moneyText(paise) as Intl.StringNumericLiteral);
}

/** A ledger balance: "₹1,500.00 Dr" / "₹200.00 Cr" / "₹0.00" (+ = Dr). */
export const drCr = (paise: bigint) => (paise === 0n ? formatMoney(0n) : `${formatMoney(paise < 0n ? -paise : paise)} ${paise < 0n ? "Cr" : "Dr"}`);

/**
 * Paise → rupees as a JS number, for Excel cells ONLY (D59): Excel needs numbers, so this is the one float in the app —
 * display, never maths. Read from the exact decimal text, so 123450n → 1234.5 exactly as Excel would type it.
 */
export const excelRupees = (paise: bigint): number => Number(moneyText(paise));

/** Thousandths → a JS number for Excel cells ONLY (D60), like excelRupees: 12500n → 12.5. Display, never maths. */
export const excelQty = (milli: bigint): number => Number(milliText(milli));

/** same_state → CGST + SGST · other_state → IGST · estimate → no GST (D18). */
export type GstMode = "same_state" | "other_state" | "estimate";
/** qty in thousandths · rate and discount in paise · gstBp in basis points. */
export type LineInput = { qty: bigint; rate: bigint; discount?: bigint; gstBp: number };

/** One line (ARCHITECTURE §4): amount = round(qty × rate), taxable = amount − discount, GST rounded per line. */
export function lineCalc({ qty, rate, discount = 0n, gstBp }: LineInput, mode: GstMode) {
  const amount = divRound(qty * rate, 1000n);
  // A negative line takes no discount.
  if (discount < 0n || discount > (amount > 0n ? amount : 0n)) {
    throw new Error("Discount must be between 0 and the line amount");
  }
  const taxable = amount - discount;
  return { amount, taxable, ...gstOn(taxable, gstBp, mode) };
}

/** GST on a taxable amount (A§4): same state → CGST + SGST, each half-up; other state → IGST; estimate → none. */
export function gstOn(taxable: bigint, gstBp: number, mode: GstMode) {
  const bp = BigInt(gstBp);
  const half = mode === "same_state" ? divRound(taxable * bp, 20000n) : 0n;
  const igst = mode === "other_state" ? divRound(taxable * bp, 10000n) : 0n;
  return { cgst: half, sgst: half, igst };
}

/** Credit / debit note totals (T16): GST per line on its taxable value, in the invoice's mode; no round-off (D49). */
export function noteTotals(lines: { taxable: bigint; gstBp: number }[], mode: GstMode) {
  const calc = lines.map((l) => ({ taxable: l.taxable, ...gstOn(l.taxable, l.gstBp, mode) }));
  const sum = (k: "taxable" | "cgst" | "sgst" | "igst") => calc.reduce((s, l) => s + l[k], 0n);
  const [taxable, cgst, sgst, igst] = [sum("taxable"), sum("cgst"), sum("sgst"), sum("igst")];
  return { lines: calc, taxable, cgst, sgst, igst, roundOff: 0n, total: taxable + cgst + sgst + igst };
}

/** Sums the lines, then rounds to the nearest rupee (50 paise and above rounds up) as a separate roundOff. */
export function invoiceTotals(lines: LineInput[], mode: GstMode) {
  const calc = lines.map((l) => lineCalc(l, mode));
  const sum = (k: "taxable" | "cgst" | "sgst" | "igst") => calc.reduce((s, l) => s + l[k], 0n);
  const [taxable, cgst, sgst, igst] = [sum("taxable"), sum("cgst"), sum("sgst"), sum("igst")];
  const exact = taxable + cgst + sgst + igst;
  const roundOff = divRound(exact, 100n) * 100n - exact;
  return { lines: calc, taxable, cgst, sgst, igst, roundOff, total: exact + roundOff };
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven",
  "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const SCALES: [string, bigint][] = [["Crore", 10_000_000n], ["Lakh", 100_000n], ["Thousand", 1000n], ["Hundred", 100n]];

// Indian system; above 99 crore the crore count is itself spelled out ("One Hundred Crore").
function words(n: bigint): string {
  // Number() only turns an index below 100 into an array position.
  if (n < 20n) return ONES[Number(n)];
  if (n < 100n) return `${TENS[Number(n / 10n)]} ${ONES[Number(n % 10n)]}`.trim();
  const [name, size] = SCALES.find(([, s]) => n >= s)!;
  return `${words(n / size)} ${name} ${words(n % size)}`.trim();
}

/**
 * 1234567850n → "Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only".
 * The only place invoice wording lives — adjust here once the client's sample arrives (Q3, D30).
 */
export function amountInWords(paise: bigint): string {
  if (paise < 0n) throw new Error("amountInWords: negative amount");
  const p = paise % 100n;
  return `Rupees ${words(paise / 100n) || "Zero"}${p ? ` and ${words(p)} Paise` : ""} Only`;
}

/** Basis points as a percentage, no trailing zeros: 1250 → "12.5", 1800 → "18", 5 → "0.05" (integer maths). */
export function bpText(bp: number): string {
  const abs = Math.abs(bp);
  const fraction = String(abs % 100).padStart(2, "0").replace(/0+$/, "");
  return `${bp < 0 ? "-" : ""}${Math.trunc(abs / 100)}${fraction ? `.${fraction}` : ""}`;
}
