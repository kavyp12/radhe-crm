import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { counters } from "@/db/schema";
import { dateParts, fyKey } from "@/lib/dates";

type SeriesDef = { prefix: string; pad: number; reset: "fy" | "year"; maxLength?: number };

// Every series in ARCHITECTURE §6. FY series read QT/26-27/0001, calendar-year series RDS-2026-00001.
// pad is a minimum width: numbers grow past it and are never cut.
const SERIES = {
  quotation: { prefix: "QT", pad: 4, reset: "fy" },
  job: { prefix: "RDS", pad: 5, reset: "year" }, // D16
  tax_invoice: { prefix: "RDS", pad: 4, reset: "fy", maxLength: 16 }, // GST: ≤ 16 chars
  estimate: { prefix: "EST", pad: 4, reset: "fy" },
  credit_note: { prefix: "CN", pad: 4, reset: "fy" },
  debit_note: { prefix: "DN", pad: 4, reset: "fy" },
  receipt: { prefix: "RC", pad: 4, reset: "fy" },
  vendor_payment: { prefix: "VP", pad: 4, reset: "fy" },
  purchase_bill: { prefix: "PB", pad: 4, reset: "fy" },
  expense: { prefix: "EX", pad: 4, reset: "fy" },
  transfer: { prefix: "TR", pad: 4, reset: "fy" },
  adjustment: { prefix: "JV", pad: 4, reset: "fy" },
  material_request: { prefix: "MR", pad: 4, reset: "fy" },
  purchase_order: { prefix: "PO", pad: 4, reset: "fy" },
  grn: { prefix: "GRN", pad: 4, reset: "fy" },
  stock_issue: { prefix: "SI", pad: 4, reset: "fy" },
  stock_adjustment: { prefix: "SA", pad: 4, reset: "fy" },
  print_job: { prefix: "PJ", pad: 5, reset: "fy" },
} satisfies Record<string, SeriesDef>;

export type Series = keyof typeof SERIES;

/**
 * Next number of `series` for the period `date` ('YYYY-MM-DD') falls in. Call it inside the
 * transaction that saves the document: the upsert locks the counter row until that transaction
 * ends, so parallel callers queue, and a rollback leaves the number unused (no gaps).
 */
export async function nextNumber(tx: Tx, series: Series, date: string): Promise<string> {
  const s: SeriesDef = SERIES[series];
  const period = s.reset === "fy" ? fyKey(date) : String(dateParts(date)[0]);
  // First number of a period inserts the row; the rest bump it. Either way the row stays locked.
  const [{ n }] = await tx
    .insert(counters)
    .values({ series, periodKey: period, nextValue: 2 })
    .onConflictDoUpdate({
      target: [counters.series, counters.periodKey],
      set: { nextValue: sql`${counters.nextValue} + 1` },
    })
    .returning({ n: sql<number>`${counters.nextValue} - 1` });
  const digits = String(n).padStart(s.pad, "0");
  const number = s.reset === "fy" ? `${s.prefix}/${period}/${digits}` : `${s.prefix}-${period}-${digits}`;
  if (s.maxLength && number.length > s.maxLength) {
    throw new Error(`${number} is longer than ${s.maxLength} characters`);
  }
  return number;
}
