import { and, asc, eq, sql } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db, writeTx } from "@/db";
import { accounts, approvalRequests, expenseCategories, journalEntries, journalLines, stockMoves } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { approve, SENT_FOR_APPROVAL } from "@/lib/approvals";
import { formatDate, todayIST } from "@/lib/dates";
import { ledger, post } from "@/lib/ledger";
import type { Role, SessionUser } from "@/lib/permissions";
import { saveBooks } from "@/lib/settings";
import { createItem, createStockAdjustment, getItem, listItems, updateItem, type ItemInput } from "@/lib/stock";
import { addMove, lockItems, outValue, pair } from "@/lib/stock-moves";
import { createUser } from "@/lib/users";

// T17 (S17, A§9, D20, D51): weighted average from the moves, no negative stock, adjustments, opening stock, and
// no values for users without can_view_cost.

let owner: SessionUser;
let accountant: SessionUser;
let production: SessionUser;
let noCost: SessionUser; // an accountant with can_view_cost off
let categoryId: string;
const today = todayIST();

beforeAll(async () => {
  owner = await testOwner();
  const staff = async (role: Role, username: string, canViewCost: boolean) => {
    const user = { name: `Stock ${username}`, username: `st.${username}`, role, canViewCost };
    return { ...user, id: await createUser(owner, { ...user, password: `${username}-pass-123` }) };
  };
  accountant = await staff("accountant", "accountant", true);
  production = await staff("production", "production", false);
  noCost = await staff("accountant", "nocost", false);
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  categoryId = String((await db.select().from(expenseCategories).where(eq(expenseCategories.name, "Acrylic")))[0].id);
});

const item = (name: string, patch: Partial<ItemInput> = {}) =>
  createItem(owner, { name, unit: "Sheet", categoryId, hsnSac: "3920", gstPercent: "18", ...patch });

/** A purchase as T18 posts it: a move + Dr stock (the bill's own entry is tested in T18). */
const buy = (itemId: number, qty: bigint, value: bigint) =>
  writeTx(owner, async (tx) => {
    await lockItems(tx, [itemId]);
    await addMove(tx, { itemId, date: today, qty, value, source: "purchase", sourceId: itemId });
    await post(tx, { date: today, docType: "test_purchases", docId: itemId, lines: pair(value, "stock", "opening_equity") });
  });

const adjust = (actor: SessionUser, itemId: number, qty: string, rate = "", reason = "Stock count") =>
  createStockAdjustment(actor, { itemId: String(itemId), date: formatDate(today), qty, rate, reason });

/** The document's journal lines, net per system key (+Dr / −Cr). */
async function posted(docType: string, docId: number) {
  const rows = await db
    .select({ key: accounts.systemKey, debit: journalLines.debitPaise, credit: journalLines.creditPaise })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journalEntries.docType, docType), eq(journalEntries.docId, docId)));
  const net: Record<string, bigint> = {};
  for (const r of rows) net[r.key!] = (net[r.key!] ?? 0n) + r.debit - r.credit;
  return net;
}

const cost = async (id: number) => (await getItem(owner, id))!.cost!;

test("the average cost follows several purchases at different rates; an outgoing qty is valued at it", async () => {
  const id = await item("Acrylic 3mm clear", { openingQty: "10", openingRate: "100" });
  expect(await posted("stock_items", id)).toEqual({ stock: 1000_00n, opening_equity: -1000_00n });
  await buy(id, 10_000n, 1200_00n); // 10 @ ₹120
  await buy(id, 3_000n, 292_50n); // 3 @ ₹97.50
  // Σ 23 sheets, ₹2,492.50 → ₹108.37 a sheet (108.3695…, half-up).
  expect(await cost(id)).toMatchObject({ value: 2492_50n, average: 108_37n });
  expect((await getItem(owner, id))!.qty).toBe(23_000n);

  // 7 out = round(7 × 2,49,250 ÷ 23) paise = ₹758.59 (758.5869…).
  const out = await adjust(owner, id, "-7", "", "Broken in the workshop");
  expect(out.message).toMatch(/^Saved SA\/26-27\/\d{4}\.$/);
  expect(await cost(id)).toMatchObject({ value: 2492_50n - 758_59n });
  expect((await getItem(owner, id))!.qty).toBe(16_000n);
  // Taking everything that is left takes exactly the value that is left.
  const t = { name: "x", unit: "Sheet", qty: 16_000n, value: 1733_91n };
  expect(outValue(16_000n, t)).toBe(1733_91n);
});

test("nothing goes out beyond stock: enter the purchase or an adjustment first", async () => {
  const id = await item("ACP sheet 4mm", { openingQty: "4", openingRate: "1,500" });
  await expect(adjust(owner, id, "-4.5")).rejects.toThrow("Only 4 Sheet of ACP sheet 4mm in stock: enter the purchase or an adjustment first.");
  const empty = await item("LED module 12V", { unit: "Nos" });
  await expect(adjust(owner, empty, "-1")).rejects.toThrow("Nothing of LED module 12V in stock");
  expect((await getItem(owner, id))!.qty).toBe(4_000n); // nothing moved
});

test("an adjustment posts both ways at the average; with no stock a plus needs a rate", async () => {
  const id = await item("Vinyl roll", { unit: "Roll", openingQty: "4", openingRate: "2,000" });
  const minus = await adjust(owner, id, "-1", "", "Damaged");
  const plus = await adjust(owner, id, "2", "", "Found in the store");
  const [m, p] = await Promise.all(
    [minus, plus].map(async (r) => (await db.query.stockAdjustments.findFirst({ where: (a, { eq: e }) => e(a.number, r.message.slice(6, -1)) }))!),
  );
  expect([m.qtyMilli, m.valuePaise, p.qtyMilli, p.valuePaise]).toEqual([-1_000n, -2000_00n, 2_000n, 4000_00n]);
  // Less: Dr cash short / excess, Cr stock. More: Dr stock, Cr cash short / excess.
  expect(await posted("stock_adjustments", m.id)).toEqual({ cash_short_excess: 2000_00n, stock: -2000_00n });
  expect(await posted("stock_adjustments", p.id)).toEqual({ stock: 4000_00n, cash_short_excess: -4000_00n });

  const none = await item("SMPS 12V 30A", { unit: "Nos", gstPercent: "" });
  await expect(adjust(owner, none, "5")).rejects.toThrow("has no stock, so there is no average: enter the rate");
  await adjust(owner, none, "5", "40", "Found");
  expect(await cost(none)).toMatchObject({ value: 200_00n, average: 40_00n });
});

test("an accountant's adjustment waits for the owner; nothing moves until it is approved", async () => {
  const id = await item("Aluminium coil", { unit: "Kg", openingQty: "50", openingRate: "300" });
  const r = await adjust(accountant, id, "-2", "", "Scrap");
  expect(r).toEqual({ id: null, message: SENT_FOR_APPROVAL });
  expect((await getItem(owner, id))!.qty).toBe(50_000n);
  const [req] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.type, "stock_adjustment.create"), eq(approvalRequests.requestedBy, accountant.id)));
  expect(req.summary).toBe("Stock adjustment: Aluminium coil -2 Kg");
  await approve(owner, req.id, "");
  expect(await cost(id)).toMatchObject({ value: 14400_00n, average: 300_00n });
  expect((await getItem(owner, id))!.qty).toBe(48_000n);
});

test("opening stock: owner / accountant with cost only; a change is reversed and posted again", async () => {
  const id = await item("Flex 10 ft", { unit: "Sq Ft", openingQty: "100", openingRate: "12" });
  const edit = (actor: SessionUser, qty: string, rate: string) =>
    updateItem(actor, id, { name: "Flex 10 ft", unit: "Sq Ft", categoryId, hsnSac: "", gstPercent: "", openingQty: qty, openingRate: rate });
  await edit(accountant, "120", "12.50");
  expect(await posted("stock_items", id)).toEqual({ stock: 1500_00n, opening_equity: -1500_00n }); // net of the reversal
  const moves = await db.select().from(stockMoves).where(eq(stockMoves.itemId, id)).orderBy(asc(stockMoves.id));
  expect(moves.map((m) => [m.qtyMilli, m.valuePaise, m.reversesMoveId !== null])).toEqual([
    [100_000n, 1200_00n, false],
    [-100_000n, -1200_00n, true],
    [120_000n, 1500_00n, false],
  ]);
  expect(moves.every((m) => m.date === "2026-04-01")).toBe(true); // the books start date
  await expect(edit(noCost, "1", "1")).rejects.toThrow("Only the owner or the accountant can set opening stock.");
  // Opening stock can't be cut below what has gone out since.
  await adjust(owner, id, "-110", "", "Used");
  await expect(edit(owner, "100", "12.50")).rejects.toThrow("Flex 10 ft would go below zero stock");
});

test("users without can_view_cost (production, a no-cost accountant) get no value, average or rate", async () => {
  const id = await item("Ink cyan", { unit: "Litre", openingQty: "5", openingRate: "900" });
  await adjust(owner, id, "-1", "", "Leak");
  for (const user of [production, noCost]) {
    const row = (await listItems(user)).find((r) => r.id === id)!;
    expect(row).toMatchObject({ qty: 4_000n, unit: "Litre" });
    expect(row).not.toHaveProperty("cost");
    const got = (await getItem(user, id))!;
    expect(got).not.toHaveProperty("cost");
    expect(got).not.toHaveProperty("openingRatePaise");
    expect(got.moves.map((m) => m.qty)).toEqual([5_000n, -1_000n]);
    expect(got.moves.some((m) => "cost" in m)).toBe(false);
  }
  expect((await listItems(owner)).find((r) => r.id === id)).toHaveProperty("cost.value", 3600_00n);
});

test("the stock account = the value of all stock moves", async () => {
  const [{ value }] = await db.select({ value: sql<string>`coalesce(sum(${stockMoves.valuePaise}), 0)` }).from(stockMoves);
  expect((await ledger({ account: "stock" })).closing).toBe(BigInt(value));
});
