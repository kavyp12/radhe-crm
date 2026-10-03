import { eq } from "drizzle-orm";
import { beforeAll, expect, onTestFinished, test } from "vitest";
import { db, writeTx } from "@/db";
import { accounts, journalEntries } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { ledger, moveOpenings, post, reverse, SYSTEM_KEYS, systemAccountId, type PostLine } from "@/lib/ledger";
import type { SessionUser } from "@/lib/permissions";
import { saveBooks } from "@/lib/settings";

// Generic entries are dated in 2091 (after the books start date, D43) on non-money accounts, so nothing else in
// the test DB lands in their ranges.

let owner: SessionUser;
beforeAll(async () => {
  owner = await testOwner();
});

const doc = { docType: "test", docId: 1 };
const entry = (date: string, lines: PostLine[], extra: { number?: string } = {}) =>
  writeTx(owner, (tx) => post(tx, { date, ...doc, ...extra, lines }));

test("every A§3 system account exists after migrate, with 5 money accounts", async () => {
  const rows = await db.select().from(accounts).orderBy(accounts.code);
  expect(rows.map((a) => a.systemKey).filter(Boolean).sort()).toEqual([...SYSTEM_KEYS].sort());
  expect(rows.filter((a) => a.isMoney).map((a) => a.systemKey)).toEqual(["cash", "petty_cash", "upi", "bank_1", "bank_2"]);
});

test("the DB rejects, at commit, an unbalanced entry or one with fewer than 2 lines, even without post()", async () => {
  const [capital, bad] = [await systemAccountId("capital"), await systemAccountId("bad_debts")];
  const sql = db.$client;
  const attempt = (lines: [number, number, number][]) =>
    sql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${owner.id}, true)`;
      const [e] = await tx`insert into journal_entries (date, doc_type, doc_id) values ('2091-01-01', 'raw', 1) returning id`;
      for (const [account, dr, cr] of lines) {
        await tx`insert into journal_lines (entry_id, account_id, debit_paise, credit_paise)
                 values (${e.id}, ${account}, ${dr}, ${cr})`;
      }
    });

  await expect(attempt([[capital, 100, 0], [bad, 0, 90]])).rejects.toThrow("is unbalanced");
  await expect(attempt([[capital, 100, 0]])).rejects.toThrow("needs at least 2 lines");
  await expect(attempt([])).rejects.toThrow("needs at least 2 lines");
  await expect(attempt([[capital, 100, 100], [bad, 0, 0]])).rejects.toThrow("journal_lines_one_side");
  await expect(attempt([[capital, 100, 0], [bad, 0, 100]])).resolves.toBeUndefined(); // balanced: commits
  // A line added later to a committed entry is checked too.
  const id = await entry("2091-01-02", [
    { account: "capital", debit: 50n },
    { account: "bad_debts", credit: 50n },
  ]);
  await expect(
    sql.begin((tx) => tx`insert into journal_lines (entry_id, account_id, debit_paise) values (${id}, ${capital}, 1)`),
  ).rejects.toThrow("is unbalanced");
});

test("journal rows can't change: UPDATE, DELETE and TRUNCATE fail on both tables", async () => {
  const id = await entry("2091-01-03", [
    { account: "capital", debit: 100n },
    { account: "bad_debts", credit: 100n },
  ]);
  const sql = db.$client;
  await expect(sql`update journal_entries set narration = 'x' where id = ${id}`).rejects.toThrow(
    "journal_entries is append-only",
  );
  await expect(sql`delete from journal_entries where id = ${id}`).rejects.toThrow("journal_entries is append-only");
  await expect(sql`truncate journal_entries cascade`).rejects.toThrow("is append-only");
  await expect(sql`update journal_lines set debit_paise = 1 where entry_id = ${id}`).rejects.toThrow(
    "journal_lines is append-only",
  );
  await expect(sql`delete from journal_lines where entry_id = ${id}`).rejects.toThrow("journal_lines is append-only");
  await expect(sql`truncate journal_lines`).rejects.toThrow("journal_lines is append-only");
  expect((await ledger({ account: "capital" }, "2091-01-03", "2091-01-03")).rows).toHaveLength(1);
});

test("a reversal mirrors the entry with the same number, nets to zero, and can be done only once", async () => {
  const before = await ledger({ account: "round_off" }, undefined, "2091-01-31");
  const id = await entry(
    "2091-02-01",
    [
      { account: "capital", debit: 75_050n },
      { account: "round_off", credit: 75_000n },
      { account: "sales", credit: 50n },
    ],
    { number: "TEST/0001" },
  );
  const reversalId = await writeTx(owner, (tx) => reverse(tx, id, "2091-02-03"));

  const [r] = await db.select().from(journalEntries).where(eq(journalEntries.id, reversalId));
  expect(r).toMatchObject({ reversesEntryId: id, number: "TEST/0001", docType: "test", docId: 1, date: "2091-02-03" });
  const period = await ledger({ account: "round_off" }, "2091-02-01", "2091-02-28");
  expect(period.opening).toBe(before.closing);
  expect(period.rows.map((row) => [row.debit, row.credit])).toEqual([
    [0n, 75_000n],
    [75_000n, 0n],
  ]);
  expect(period.closing).toBe(period.opening); // nets to zero

  await expect(writeTx(owner, (tx) => reverse(tx, id, "2091-02-04"))).rejects.toThrow("already reversed");
  await expect(writeTx(owner, (tx) => reverse(tx, reversalId, "2091-02-04"))).rejects.toThrow("is a reversal");
  const sql = db.$client; // and the DB itself allows one reversal per entry
  await expect(
    sql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${owner.id}, true)`;
      await tx`insert into journal_entries (date, doc_type, doc_id, reverses_entry_id) values ('2091-02-05', 'test', 1, ${id})`;
    }),
  ).rejects.toThrow("journal_entries_reverses_entry_id_unique");
});

test("ledger: balance before the range, running balance inside it, closing; later lines excluded", async () => {
  const pv = (date: string, dr: bigint, cr: bigint) =>
    entry(date, [
      { account: "price_variance", debit: dr, credit: cr },
      { account: "capital", debit: cr, credit: dr },
    ]);
  // Other test files post to price_variance too (bills from GRNs, T23): count from what was there before.
  const base = (await ledger({ account: "price_variance" }, "2091-03-01")).opening;
  await pv("2091-03-05", 1_000_00n, 0n);
  await pv("2091-03-10", 500_00n, 0n);
  await pv("2091-03-15", 0n, 200_00n);
  await pv("2091-03-20", 300_50n, 0n);
  await pv("2091-03-25", 999_00n, 0n);

  const l = await ledger({ account: "price_variance" }, "2091-03-10", "2091-03-20");
  expect(l.opening).toBe(base + 1_000_00n);
  expect(l.rows.map((r) => [r.date, r.balance])).toEqual([
    ["2091-03-10", base + 1_500_00n],
    ["2091-03-15", base + 1_300_00n],
    ["2091-03-20", base + 1_600_50n],
  ]);
  expect(l.closing).toBe(base + 1_600_50n);
  expect((await ledger({ account: "price_variance" }, undefined, "2091-03-31")).closing).toBe(base + 2_599_50n);
});

test("post() refuses without a signed-in user, and refuses an unbalanced entry", async () => {
  const lines: PostLine[] = [
    { account: "capital", debit: 100n },
    { account: "bad_debts", credit: 100n },
  ];
  const input = { date: "2091-04-01", ...doc, lines };
  await expect(writeTx(null, (tx) => post(tx, input))).rejects.toThrow("needs a signed-in user");
  await expect(db.transaction((tx) => post(tx, input))).rejects.toThrow("needs a signed-in user");
  await expect(entry("2091-04-01", [lines[0], { account: "bad_debts", credit: 99n }])).rejects.toThrow("Unbalanced");
  await expect(entry("2091-04-01", [lines[0]])).rejects.toThrow("Unbalanced");
});

test("money account opening: Dr money / Cr opening_equity on the books start date; a change reverses + reposts", async () => {
  const cash = await systemAccountId("cash");
  const openings = async (account: number | "opening_equity", date: string) =>
    (await ledger({ account }, date, date)).rows.filter((r) => r.docType === "accounts" && r.docId === cash);
  const net = (rows: { debit: bigint; credit: bigint }[]) => rows.reduce((s, r) => s + r.debit - r.credit, 0n);

  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [{ id: cash, name: "Cash", opening: "10,000" }] });
  expect(net(await openings(cash, "2026-04-01"))).toBe(10_000_00n);
  expect(net(await openings("opening_equity", "2026-04-01"))).toBe(-10_000_00n);

  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [{ id: cash, name: "Cash in hand", opening: "12,000.50" }] });
  // D68: other files read "Cash" with no opening — put it back even when a check below fails.
  onTestFinished(() => saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [{ id: cash, name: "Cash", opening: "" }] }));
  const rows = await openings(cash, "2026-04-01");
  expect(rows.map((r) => [r.debit, r.credit])).toEqual([
    [10_000_00n, 0n],
    [0n, 10_000_00n],
    [12_000_50n, 0n],
  ]);
  const [account] = await db.select().from(accounts).where(eq(accounts.id, cash));
  expect(account).toMatchObject({ name: "Cash in hand", openingBalancePaise: 12_000_50n });

  // Documents have posted (the generic entries above), so the date is locked (D43). While it could still move,
  // moveOpenings re-posts every opening balance on the new date.
  await expect(saveBooks(owner, { booksStartDate: "02/04/2026", accounts: [] })).rejects.toThrow("can't change any more");
  await expect(saveBooks(owner, { booksStartDate: "", accounts: [] })).rejects.toMatchObject({ field: "booksStartDate" });
  await writeTx(owner, (tx) => moveOpenings(tx, "2026-04-02"));
  expect(net(await openings(cash, "2026-04-01"))).toBe(0n);
  expect(net(await openings(cash, "2026-04-02"))).toBe(12_000_50n);
  await writeTx(owner, (tx) => moveOpenings(tx, "2026-04-01"));
  expect(net(await openings(cash, "2026-04-01"))).toBe(12_000_50n);
  await expect(
    saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [{ id: cash, name: "Cash", opening: "12.345" }] }),
  ).rejects.toMatchObject({ field: `opening.${cash}` });
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [{ id: cash, name: "Cash", opening: "" }] });
  expect(net(await openings(cash, "2026-04-01"))).toBe(0n);
  await expect(saveBooks({ ...owner, role: "accountant" }, { booksStartDate: "", accounts: [] })).rejects.toThrow(
    "Not allowed",
  );
});

test("nothing but opening balances can be dated before the books start date (D43)", async () => {
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const lines: PostLine[] = [
    { account: "capital", debit: 1n },
    { account: "bad_debts", credit: 1n },
  ];
  await expect(entry("2026-03-31", lines)).rejects.toThrow("The books start on 01/04/2026");
  await entry("2026-04-01", lines);
});
