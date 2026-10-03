import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

// Prod (D69): DATABASE_URL is Supabase's transaction pooler, which can't keep prepared statements, and each Vercel
// function instance keeps a small pool (the pooler shares the database's real connections between them); idle ones
// close so a sleeping instance holds nothing. The same settings work against one local PostgreSQL.
// ponytail: 5 per instance; more only if requests queue for a connection under load.
// Reuse one connection pool across dev hot reloads.
const g = globalThis as unknown as { pgClient?: postgres.Sql };
const client = g.pgClient ?? postgres(url, { prepare: false, max: process.env.VERCEL ? 5 : 10, idle_timeout: 20 });
if (process.env.NODE_ENV !== "production") g.pgClient = client;

export const db = drizzle({ client, schema });

/** The `tx` inside db.transaction(async (tx) => …). */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Every app write goes through here (hard rule 4): one transaction that first records who is writing, so the
 * audit triggers (migration 0004) can stamp each change. `null` = the system (seed), recorded without a user.
 */
export function writeTx<T>(user: { id: string } | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (user) await tx.execute(sql`select set_config('app.user_id', ${user.id}, true)`);
    return fn(tx);
  });
}
