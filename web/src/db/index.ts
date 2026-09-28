import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

// Reuse one connection pool across dev hot reloads.
const g = globalThis as unknown as { pgClient?: postgres.Sql };
const client = g.pgClient ?? postgres(url);
if (process.env.NODE_ENV !== "production") g.pgClient = client;

export const db = drizzle({ client, schema });

/** The `tx` inside db.transaction(async (tx) => …). */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
