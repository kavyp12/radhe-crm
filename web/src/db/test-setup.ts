import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Vitest globalSetup: wipe the test DB and migrate it from scratch before each run.
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [{ name }] = await sql<{ name: string }[]>`select current_database() as name`;
    if (!name.endsWith("_test")) {
      throw new Error(`Refusing to reset "${name}": the test DB name must end in _test`);
    }
    const schemas = await sql<{ nspname: string }[]>`
      select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'`;
    for (const { nspname } of schemas) await sql`drop schema ${sql(nspname)} cascade`;
    await sql`create schema public`;
    await migrate(drizzle({ client: sql }), { migrationsFolder: "./drizzle" });
  } finally {
    await sql.end();
  }
}
