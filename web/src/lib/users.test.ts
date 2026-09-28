import { count, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { UserError } from "@/lib/action";
import { auth } from "@/lib/auth";
import type { SessionUser } from "@/lib/permissions";
import { createUser, resetPassword, seedOwner, updateUser } from "@/lib/users";

const OWNER = { name: "Owner", username: "owner", password: "owner-pass-1" };
let seeded: string[];
let owner: SessionUser;

beforeAll(async () => {
  seeded = [await seedOwner(OWNER), await seedOwner(OWNER)];
  const [row] = await db.select().from(users).where(eq(users.role, "owner"));
  owner = { id: row.id, name: row.name, username: row.username ?? "", role: row.role, canViewCost: row.canViewCost };
});

/** Signs in through Better Auth and returns request headers carrying the session cookie. */
async function signIn(username: string, password: string) {
  const { headers } = await auth.api.signInUsername({ body: { username, password }, returnHeaders: true });
  return new Headers({ cookie: headers.get("set-cookie")!.split(";")[0] });
}
const sessionCount = async (userId: string) =>
  (await db.select({ n: count() }).from(sessions).where(eq(sessions.userId, userId)))[0].n;

test("seed run twice → one owner", async () => {
  expect(seeded[1]).toBe("exists");
  const [{ n }] = await db.select({ n: count() }).from(users).where(eq(users.role, "owner"));
  expect(n).toBe(1);
});

test("a disabled user's sessions are revoked and they can't sign in", async () => {
  const id = await createUser(owner, {
    name: "Sales One",
    username: "Sales.One",
    role: "sales",
    canViewCost: false,
    password: "sales-pass-1",
  });
  const cookie = await signIn("sales.one", "sales-pass-1");
  const session = await auth.api.getSession({ headers: cookie });
  expect(session?.user).toMatchObject({ username: "sales.one", role: "sales", canViewCost: false, active: true });

  await updateUser(owner, id, { active: false });
  expect(await sessionCount(id)).toBe(0);
  expect(await auth.api.getSession({ headers: cookie })).toBeNull();
  await expect(signIn("sales.one", "sales-pass-1")).rejects.toThrow("disabled");

  await updateUser(owner, id, { active: true });
  await signIn("SALES.ONE", "sales-pass-1"); // enabled again; the username is case-insensitive
});

test("a password reset signs the user out and only the new password works", async () => {
  const id = await createUser(owner, {
    name: "Press",
    username: "press1",
    role: "production",
    canViewCost: false,
    password: "old-pass-12",
  });
  await signIn("press1", "old-pass-12");
  await resetPassword(owner, id, "new-pass-12");
  expect(await sessionCount(id)).toBe(0);
  await expect(signIn("press1", "old-pass-12")).rejects.toThrow("Invalid username or password");
  await signIn("press1", "new-pass-12");
});

test("the owner can't disable or demote their own account; other roles can't manage users", async () => {
  await expect(updateUser(owner, owner.id, { active: false })).rejects.toThrow(UserError);
  await expect(updateUser(owner, owner.id, { role: "accountant" })).rejects.toThrow(UserError);
  await updateUser(owner, owner.id, { canViewCost: true });

  const accountant: SessionUser = { ...owner, id: "someone", role: "accountant" };
  const input = { name: "X", username: "xuser", role: "sales" as const, canViewCost: false, password: "x-pass-123" };
  await expect(createUser(accountant, input)).rejects.toThrow("Not allowed");
  await expect(updateUser(accountant, owner.id, { active: false })).rejects.toThrow("Not allowed");
  await expect(resetPassword(accountant, owner.id, "whatever-123")).rejects.toThrow("Not allowed");
});

test("public sign-up is rejected", async () => {
  const body = { name: "Intruder", email: "x@example.com", password: "password123", username: "intruder" };
  const res = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(404);
  await expect(auth.api.signUpEmail({ body })).rejects.toThrow();
  expect(await db.select().from(users).where(eq(users.username, "intruder"))).toHaveLength(0);
});
