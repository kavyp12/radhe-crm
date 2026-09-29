import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { db } from "@/db";
import { counters } from "@/db/schema";
import { nextNumber, type Series } from "./numbering";

const DAY = "2026-09-28";
const take = (series: Series, date = DAY) => db.transaction((tx) => nextNumber(tx, series, date));

// Every test starts from fresh periods. The other test files' documents share this DB, so their counters are put
// back afterwards (otherwise a file running later reuses numbers that exist).
let saved: (typeof counters.$inferSelect)[] = [];
beforeAll(async () => {
  saved = await db.select().from(counters);
});
afterAll(async () => {
  await db.delete(counters);
  if (saved.length) await db.insert(counters).values(saved);
});
beforeEach(async () => {
  await db.delete(counters);
});

test("one example per ARCHITECTURE §6 series", async () => {
  const expected: Record<Series, string> = {
    quotation: "QT/26-27/0001",
    job: "RDS-2026-00001",
    tax_invoice: "RDS/26-27/0001",
    estimate: "EST/26-27/0001",
    credit_note: "CN/26-27/0001",
    debit_note: "DN/26-27/0001",
    receipt: "RC/26-27/0001",
    vendor_payment: "VP/26-27/0001",
    purchase_bill: "PB/26-27/0001",
    expense: "EX/26-27/0001",
    transfer: "TR/26-27/0001",
    adjustment: "JV/26-27/0001",
    material_request: "MR/26-27/0001",
    purchase_order: "PO/26-27/0001",
    grn: "GRN/26-27/0001",
    stock_issue: "SI/26-27/0001",
    stock_adjustment: "SA/26-27/0001",
    print_job: "PJ/26-27/00001",
  };
  const got = {} as Record<Series, string>;
  for (const s of Object.keys(expected) as Series[]) got[s] = await take(s);
  expect(got).toEqual(expected);
  expect(await take("tax_invoice")).toBe("RDS/26-27/0002");
});

test("FY series restart on 1 April, job numbers on 1 January", async () => {
  expect(await take("tax_invoice", "2026-12-31")).toBe("RDS/26-27/0001");
  expect(await take("tax_invoice", "2027-01-01")).toBe("RDS/26-27/0002");
  expect(await take("tax_invoice", "2027-03-31")).toBe("RDS/26-27/0003");
  expect(await take("tax_invoice", "2027-04-01")).toBe("RDS/27-28/0001");

  expect(await take("job", "2026-12-31")).toBe("RDS-2026-00001");
  expect(await take("job", "2027-01-01")).toBe("RDS-2027-00001");
  expect(await take("job", "2027-04-01")).toBe("RDS-2027-00002");
});

test("20 parallel transactions on a fresh period get 20 distinct consecutive numbers", async () => {
  const numbers = await Promise.all(
    Array.from({ length: 20 }, () =>
      db.transaction(async (tx) => {
        const n = await nextNumber(tx, "receipt", DAY);
        await tx.execute(sql`select pg_sleep(0.02)`); // hold the row lock so the others must queue
        return n;
      }),
    ),
  );
  expect(numbers.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `RC/26-27/${String(i + 1).padStart(4, "0")}`));
});

test("a rolled-back transaction doesn't use up a number", async () => {
  const rolledBack = async () => {
    let n = "";
    const save = db.transaction(async (tx) => {
      n = await nextNumber(tx, "estimate", DAY);
      throw new Error("save failed");
    });
    await expect(save).rejects.toThrow("save failed");
    return n;
  };
  expect(await rolledBack()).toBe("EST/26-27/0001"); // first number of the period
  expect(await take("estimate")).toBe("EST/26-27/0001");
  expect(await rolledBack()).toBe("EST/26-27/0002");
  expect(await take("estimate")).toBe("EST/26-27/0002");
});

test("tax invoice numbers are at most 16 characters; padding grows, never cuts", async () => {
  expect((await take("tax_invoice")).length).toBeLessThanOrEqual(16);
  await db.update(counters).set({ nextValue: 999_999 });
  expect(await take("tax_invoice")).toBe("RDS/26-27/999999"); // 16 chars
  await expect(take("tax_invoice")).rejects.toThrow("longer than 16");
  expect(await db.select().from(counters)).toEqual([{ series: "tax_invoice", periodKey: "26-27", nextValue: 1_000_000 }]);
});
