import { asc } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/permissions";
import { NewUserDialog } from "./forms";

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
    <div className="grid max-w-3xl gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold">Users</h1>
        <NewUserDialog />
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-muted-foreground">
            <tr>
              <th className="h-10 px-3 font-medium">Name</th>
              <th className="h-10 px-3 font-medium">Username</th>
              <th className="h-10 px-3 font-medium">Role</th>
              <th className="h-10 px-3 font-medium">Sees cost</th>
              <th className="h-10 px-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-b last:border-0">
                <td className="h-10 px-3">
                  <Link href={`/users/${u.id}`} className="font-medium hover:underline">
                    {u.name}
                  </Link>
                </td>
                <td className="px-3">{u.username}</td>
                <td className="px-3">{ROLE_LABEL[u.role]}</td>
                <td className="px-3">{u.canViewCost ? "Yes" : "No"}</td>
                <td className="px-3">{u.active ? "Active" : "Disabled"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
