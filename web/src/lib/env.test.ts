import { expect, test } from "vitest";
import { checkEnv, envProblems } from "@/lib/env";

// T44a: production refuses to start on missing or weak settings, naming each; dev and tests stay relaxed.
const good = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://app@pooler.example.com:6543/postgres?sslmode=require",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "https://crm.example.com",
  STORAGE_DRIVER: "supabase",
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc",
  SUPABASE_BUCKET: "radhe-files",
  VERCEL: "1",
};

test("good production settings pass; dev and test never complain", () => {
  expect(envProblems(good)).toEqual([]);
  expect(() => checkEnv(good)).not.toThrow();
  expect(envProblems({ NODE_ENV: "development" })).toEqual([]);
  expect(envProblems({ NODE_ENV: "test", BETTER_AUTH_SECRET: "short" })).toEqual([]);
  // A local production test: http://localhost and the local disk (not on Vercel).
  expect(envProblems({ ...good, BETTER_AUTH_URL: "http://localhost:3000", STORAGE_DRIVER: "", VERCEL: undefined })).toEqual([]);
  // Email fully set (user with password), or fully blank.
  expect(envProblems({ ...good, SMTP_HOST: "smtp.example.com", SMTP_PORT: "465", SMTP_USER: "a", SMTP_PASS: "b", MAIL_FROM: "A <a@example.com>" })).toEqual([]);
});

test("each missing or weak value is named; checkEnv stops with all of them", () => {
  const bad = (patch: Record<string, string | undefined>) => envProblems({ ...good, ...patch });
  expect(bad({ DATABASE_URL: "" })).toEqual(["DATABASE_URL is not set."]);
  expect(bad({ BETTER_AUTH_SECRET: "CHANGE_ME" })).toEqual(["BETTER_AUTH_SECRET must be at least 32 random characters."]);
  for (const url of ["http://crm.example.com", "crm.example.com", ""]) expect(bad({ BETTER_AUTH_URL: url })).toEqual([expect.stringContaining("BETTER_AUTH_URL")]);
  expect(bad({ SUPABASE_BUCKET: "", SUPABASE_SERVICE_ROLE_KEY: " " })).toEqual([
    "SUPABASE_SERVICE_ROLE_KEY is not set (STORAGE_DRIVER=supabase).",
    "SUPABASE_BUCKET is not set (STORAGE_DRIVER=supabase).",
  ]);
  expect(bad({ SUPABASE_URL: "http://abc.supabase.co" })).toEqual(["SUPABASE_URL must be the project's https:// address."]);
  expect(bad({ STORAGE_DRIVER: "s3" })).toEqual([expect.stringContaining('not "s3"')]);
  expect(bad({ STORAGE_DRIVER: "local" })).toEqual([expect.stringContaining("on Vercel")]);
  // SMTP half set.
  expect(bad({ SMTP_HOST: "smtp.example.com" })).toEqual([expect.stringMatching(/^MAIL_FROM is not set/)]);
  expect(bad({ SMTP_HOST: "smtp.example.com", MAIL_FROM: "a@example.com", SMTP_USER: "a" })).toEqual(["SMTP_USER and SMTP_PASS go together: set both or neither."]);
  expect(bad({ SMTP_HOST: "h", MAIL_FROM: "m", SMTP_PORT: "smtp" })).toEqual(["SMTP_PORT must be a port number such as 587 or 465."]);

  expect(() => checkEnv({ ...good, DATABASE_URL: "", BETTER_AUTH_SECRET: "" })).toThrow(
    /can't start.*\n- DATABASE_URL is not set\.\n- BETTER_AUTH_SECRET must be at least 32/s,
  );
});
