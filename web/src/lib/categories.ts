import { asc, eq, sql } from "drizzle-orm";
import { db, writeTx, type Tx } from "@/db";
import { accounts, expenseCategories, productCategories } from "@/db/schema";
import { formText, UserError } from "@/lib/action";
import { COST_BUCKETS, type CostBucket } from "@/lib/cost-buckets";
import { parseMoney } from "@/lib/num";
import { can, type SessionUser } from "@/lib/permissions";

// Product (S4) and expense (S10) categories: owner + accountant (D36). Never deleted, only deactivated. A name is
// set when the category is added (renaming isn't offered). Loaders stay open: sales lines pick product categories.

export const listProductCategories = () => db.select().from(productCategories).orderBy(asc(productCategories.id));

export const listExpenseCategories = () =>
  db
    .select({
      id: expenseCategories.id,
      name: expenseCategories.name,
      costBucket: expenseCategories.costBucket,
      active: expenseCategories.active,
      accountId: expenseCategories.accountId,
      accountCode: accounts.code,
    })
    .from(expenseCategories)
    .innerJoin(accounts, eq(accounts.id, expenseCategories.accountId))
    .orderBy(asc(expenseCategories.id));

export type ProductCategoryInput = { name: string; hsnSac: string; gstPercent: string; active: boolean };
export type ExpenseCategoryInput = { name: string; costBucket: string; active: boolean };

function allowed(actor: SessionUser) {
  if (!can(actor, "categories", "edit")) throw new Error("Not allowed");
}

/** Blank = not known yet (Q2). Digits only, 4 to 8 of them. */
export function hsnSac(value: string): string | null {
  const v = value.replace(/\s/g, "");
  if (v && !/^\d{4,8}$/.test(v)) throw new UserError("HSN / SAC is 4 to 8 digits.", "hsnSac");
  return v || null;
}

/** "18" or "12.5" (%) → basis points, the same 2-decimal parse as the discount limit. */
export function gstBp(value: string): number {
  let bp: number;
  try {
    bp = Number(parseMoney(value));
  } catch {
    bp = -1;
  }
  if (bp < 0 || bp > 10000) throw new UserError("Enter the GST % from 0 to 100, up to 2 decimals.", "gstPercent");
  return bp;
}

async function newName(tx: Tx, table: typeof productCategories | typeof expenseCategories, value: string) {
  const name = formText(value, "name", 100);
  if (!name) throw new UserError("Enter a name.", "name");
  const [taken] = await tx.select({ id: table.id }).from(table).where(sql`lower(${table.name}) = lower(${name})`);
  if (taken) throw new UserError("There is already a category with this name.", "name");
  return name;
}

/** id null = add a new one. */
export async function saveProductCategory(actor: SessionUser, id: number | null, input: ProductCategoryInput) {
  allowed(actor);
  const values = { hsnSac: hsnSac(input.hsnSac), gstBp: gstBp(input.gstPercent), active: input.active };
  await writeTx(actor, async (tx) => {
    if (id === null) {
      await tx.insert(productCategories).values({ name: await newName(tx, productCategories, input.name), ...values });
      return;
    }
    const [row] = await tx
      .update(productCategories)
      .set(values)
      .where(eq(productCategories.id, id))
      .returning({ id: productCategories.id });
    if (!row) throw new UserError("That category doesn't exist.");
  });
}

/** id null = add a new one, with its own expense account (the next 6xxx code, A§3). */
export async function saveExpenseCategory(actor: SessionUser, id: number | null, input: ExpenseCategoryInput) {
  allowed(actor);
  if (!COST_BUCKETS.includes(input.costBucket as CostBucket)) throw new UserError("Pick a cost bucket.", "costBucket");
  const values = { costBucket: input.costBucket as CostBucket, active: input.active };
  await writeTx(actor, async (tx) => {
    if (id === null) {
      const name = await newName(tx, expenseCategories, input.name);
      // Two people adding at the same moment would pick the same code; the unique code makes one of them fail.
      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(${accounts.code}::int), 6000) + 1` })
        .from(accounts)
        .where(sql`${accounts.code} ~ '^6[0-9]{3}$'`);
      const [account] = await tx
        .insert(accounts)
        .values({ code: String(next), name, type: "expense" })
        .returning({ id: accounts.id });
      await tx.insert(expenseCategories).values({ name, accountId: account.id, ...values });
      return;
    }
    const [row] = await tx
      .update(expenseCategories)
      .set(values)
      .where(eq(expenseCategories.id, id))
      .returning({ id: expenseCategories.id });
    if (!row) throw new UserError("That category doesn't exist.");
  });
}
