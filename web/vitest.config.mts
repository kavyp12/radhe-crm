import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    // Tests use the app's own db client, pointed at the test DB.
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL },
    globalSetup: ["./src/db/test-setup.ts"],
    // All test files share one DB, so run them one at a time.
    fileParallelism: false,
  },
});
