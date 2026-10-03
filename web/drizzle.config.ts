import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  // D69: migrations go through the direct (session) connection; the app's pooled DATABASE_URL can't run them.
  dbCredentials: { url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL! },
});
