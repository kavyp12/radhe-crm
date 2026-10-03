import { checkEnv } from "@/lib/env";

// Imported once by instrumentation.ts on a Node.js server start: bad production settings stop the process with the
// list of what to fix, instead of a server that answers every request with a 500.
try {
  checkEnv();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
