import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { username } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { authAccounts, sessions, users, verifications } from "@/db/schema";
import { can, ROLES, type Action, type Area, type SessionUser } from "@/lib/permissions";

// The only Better Auth endpoints reachable (HTTP or auth.api). Users are created, changed and disabled by the
// owner through lib/users.ts, never through sign-up or self-service endpoints.
const OPEN_ENDPOINTS = new Set(["/sign-in/username", "/get-session", "/sign-out"]);

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { users, sessions, auth_accounts: authAccounts, verifications },
  }),
  user: {
    modelName: "users",
    additionalFields: {
      role: { type: [...ROLES], required: true, input: false },
      canViewCost: { type: "boolean", required: true, input: false },
      active: { type: "boolean", required: true, defaultValue: true, input: false },
    },
  },
  session: { modelName: "sessions" },
  account: { modelName: "auth_accounts" },
  verification: { modelName: "verifications" },
  emailAndPassword: { enabled: true, disableSignUp: true },
  plugins: [username(), nextCookies()],
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!OPEN_ENDPOINTS.has(ctx.path)) throw new APIError("NOT_FOUND");
    }),
  },
  databaseHooks: {
    session: {
      create: {
        // Runs after the password check, so only the right password learns the account is disabled.
        before: async (session) => {
          const [user] = await db.select({ active: users.active }).from(users).where(eq(users.id, session.userId));
          if (!user?.active) throw new APIError("FORBIDDEN", { message: "This account is disabled. Ask the owner." });
        },
      },
    },
  },
});

/** The signed-in, active user for these request headers, or null. Route handlers: answer 401 on null. */
export async function userFromHeaders(requestHeaders: Headers): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user.active) return null;
  const { id, name, username, role, canViewCost } = session.user;
  return { id, name, username: username ?? "", role, canViewCost };
}

/** The signed-in, active user of this page / server action request, or null. */
export const getUser = cache(async () => userFromHeaders(await headers()));

/** Pages and server actions: no session → /login. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

/** Pages and server actions: not allowed → dashboard (which sends production on to /jobs). */
export async function requirePermission(area: Area, action?: Action): Promise<SessionUser> {
  const user = await requireUser();
  if (!can(user, area, action)) redirect("/");
  return user;
}
