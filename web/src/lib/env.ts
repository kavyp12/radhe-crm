// Start-up check of the server's settings (T44a). In production a missing or weak value stops the app with a message
// naming it — src/instrumentation.ts runs this once when a server starts, so the message is in the host's logs.
// Dev and tests stay relaxed. web/.env.example and docs/DEPLOY.md §2 list every variable.

const SMTP = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"] as const;

/** What is wrong with these settings for a production server (empty = fine, and always empty outside production). */
export function envProblems(env: Record<string, string | undefined> = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  const has = (key: string) => !!env[key]?.trim();
  const url = (key: string) => {
    try {
      return new URL(env[key] ?? "");
    } catch {
      return null;
    }
  };

  if (!has("DATABASE_URL")) problems.push("DATABASE_URL is not set.");
  if ((env.BETTER_AUTH_SECRET ?? "").trim().length < 32) problems.push("BETTER_AUTH_SECRET must be at least 32 random characters.");
  const site = url("BETTER_AUTH_URL");
  const localTest = site?.protocol === "http:" && ["localhost", "127.0.0.1"].includes(site.hostname);
  if (!site || (site.protocol !== "https:" && !localTest)) {
    problems.push("BETTER_AUTH_URL must be the site's https:// address (http://localhost only for a local test).");
  }

  const driver = env.STORAGE_DRIVER?.trim() || "local";
  if (driver === "supabase") {
    for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_BUCKET"]) if (!has(key)) problems.push(`${key} is not set (STORAGE_DRIVER=supabase).`);
    if (has("SUPABASE_URL") && url("SUPABASE_URL")?.protocol !== "https:") problems.push("SUPABASE_URL must be the project's https:// address.");
  } else if (driver !== "local") {
    problems.push(`STORAGE_DRIVER must be "local" or "supabase", not "${driver}".`);
  } else if (env.VERCEL) {
    problems.push("STORAGE_DRIVER must be supabase on Vercel: its disk isn't kept, so uploaded files would be lost.");
  }

  // Email: all blank = off; otherwise a host and a from address, and a user only with its password.
  if (SMTP.some(has)) {
    for (const key of ["SMTP_HOST", "MAIL_FROM"]) if (!has(key)) problems.push(`${key} is not set: email is half set up (fill it, or clear every SMTP_ / MAIL_FROM value).`);
    if (has("SMTP_USER") !== has("SMTP_PASS")) problems.push("SMTP_USER and SMTP_PASS go together: set both or neither.");
    if (has("SMTP_PORT") && !/^\d{1,5}$/.test(env.SMTP_PORT!.trim())) problems.push("SMTP_PORT must be a port number such as 587 or 465.");
  }
  return problems;
}

/** Throws one message listing every problem: the server doesn't start on bad settings. */
export function checkEnv(env: Record<string, string | undefined> = process.env) {
  const problems = envProblems(env);
  if (problems.length) throw new Error(`Radhe CRM can't start: fix these settings (see docs/DEPLOY.md §2).\n- ${problems.join("\n- ")}`);
}
