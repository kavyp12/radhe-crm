/** Runs once when a server starts (Next.js instrumentation): bad production settings stop it here (T44a). */
export async function register() {
  // Next calls register in every runtime; the check is Node.js only (Next docs pattern; nothing here uses Edge).
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./startup-check");
}
