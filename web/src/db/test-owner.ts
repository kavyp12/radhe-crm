import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { auth } from "@/lib/auth";
import type { SessionUser } from "@/lib/permissions";
import { seedOwner } from "@/lib/users";

// Test helpers. Test files share one DB, so they share one owner: seeded by whichever file asks first.
export const OWNER = { name: "Owner", username: "owner", password: "owner-pass-1" };

export async function testOwner(): Promise<SessionUser> {
  await seedOwner(OWNER);
  const [row] = await db.select().from(users).where(eq(users.role, "owner"));
  return { id: row.id, name: row.name, username: row.username ?? "", role: row.role, canViewCost: row.canViewCost };
}

/** Signs in through Better Auth; returns request headers carrying the session cookie. */
export async function signedIn(username: string, password: string): Promise<Headers> {
  const { headers } = await auth.api.signInUsername({ body: { username, password }, returnHeaders: true });
  return new Headers({ cookie: headers.get("set-cookie")!.split(";")[0] });
}
