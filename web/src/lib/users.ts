import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { writeTx, type Tx } from "@/db";
import { authAccounts, sessions, users } from "@/db/schema";
import { UserError } from "@/lib/action";
import { can, ROLES, type Role, type SessionUser } from "@/lib/permissions";

// Staff accounts (S21). Written straight to Better Auth's tables through writeTx — the same rows its sign-up
// writes — so every change to a user is audited with the owner who made it.

export type NewUser = { name: string; username: string; role: Role; canViewCost: boolean; password: string };
export type UserChanges = { role?: Role; canViewCost?: boolean; active?: boolean };

// Better Auth's username plugin rules; it lowercases the username on sign-in.
const USERNAME = /^[a-zA-Z0-9_.]{3,30}$/;

function checkPassword(password: string) {
  if (password.length < 8 || password.length > 128) throw new UserError("Password must be 8–128 characters.");
}

function checkRole(role: string): asserts role is Role {
  if (!ROLES.includes(role as Role)) throw new UserError("Pick a role.");
}

function allow(actor: SessionUser, action: "create" | "edit") {
  if (!can(actor, "users", action)) throw new Error("Not allowed");
}

async function insertUser(tx: Tx, input: NewUser): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new UserError("Enter a name.");
  if (!USERNAME.test(input.username)) {
    throw new UserError("Username: 3–30 letters, digits, dots or underscores.");
  }
  checkRole(input.role);
  checkPassword(input.password);
  const username = input.username.toLowerCase();
  const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.username, username));
  if (taken) throw new UserError("That username is taken.");

  const id = crypto.randomUUID();
  await tx.insert(users).values({
    id,
    name,
    username,
    displayUsername: input.username,
    email: `${id}@users.invalid`, // hidden placeholder: Better Auth requires a unique email
    role: input.role,
    canViewCost: input.canViewCost,
  });
  await tx.insert(authAccounts).values({
    id: crypto.randomUUID(),
    userId: id,
    providerId: "credential",
    accountId: id,
    password: await hashPassword(input.password),
  });
  return id;
}

export async function createUser(actor: SessionUser, input: NewUser): Promise<string> {
  allow(actor, "create");
  return writeTx(actor, (tx) => insertUser(tx, input));
}

/** Role, can_view_cost, enable / disable. Disabling signs the user out everywhere. */
export async function updateUser(actor: SessionUser, id: string, changes: UserChanges): Promise<void> {
  allow(actor, "edit");
  if (changes.role !== undefined) checkRole(changes.role);
  if (id === actor.id && (changes.active === false || (changes.role && changes.role !== actor.role))) {
    throw new UserError("You can't disable or change the role of your own account.");
  }
  await writeTx(actor, async (tx) => {
    const [row] = await tx.update(users).set(changes).where(eq(users.id, id)).returning({ id: users.id });
    if (!row) throw new UserError("User not found.");
    if (changes.active === false) await tx.delete(sessions).where(eq(sessions.userId, id));
  });
}

/** Sets a new password and signs the user out everywhere. */
export async function resetPassword(actor: SessionUser, id: string, password: string): Promise<void> {
  allow(actor, "edit");
  checkPassword(password);
  const hash = await hashPassword(password);
  await writeTx(actor, async (tx) => {
    const [row] = await tx
      .update(authAccounts)
      .set({ password: hash })
      .where(and(eq(authAccounts.userId, id), eq(authAccounts.providerId, "credential")))
      .returning({ id: authAccounts.id });
    if (!row) throw new UserError("User not found.");
    // auth_accounts isn't audited (it holds the hash); this puts the reset on the user's history.
    await tx.update(users).set({ passwordChangedAt: new Date() }).where(eq(users.id, id));
    await tx.delete(sessions).where(eq(sessions.userId, id));
  });
}

/** `pnpm db:seed`: the first owner, only while no owner exists. */
export async function seedOwner(owner: { name: string; username: string; password: string }) {
  return writeTx(null, async (tx) => {
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.role, "owner")).limit(1);
    if (existing) return "exists" as const;
    await insertUser(tx, { ...owner, role: "owner", canViewCost: true });
    return "created" as const;
  });
}
