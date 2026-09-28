import { asc } from "drizzle-orm";
import { PageHeader } from "@/components/page-header";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { NewUserDialog } from "./forms";
import { UsersTable } from "./users-table";

export default async function UsersPage() {
  await requirePermission("users", "view");
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.displayUsername,
      role: users.role,
      canViewCost: users.canViewCost,
      active: users.active,
    })
    .from(users)
    .orderBy(asc(users.name));

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Users" description="Who can sign in, and which role each person has." action={<NewUserDialog />} />
      <UsersTable users={rows.map((u) => ({ ...u, username: u.username ?? "" }))} />
    </div>
  );
}
