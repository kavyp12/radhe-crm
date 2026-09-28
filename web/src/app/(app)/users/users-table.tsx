"use client";

import { useRouter } from "next/navigation";
import { DataTable, tableColumns } from "@/components/data-table";
import { ROLE_LABEL, type Role } from "@/lib/permissions";
import { cn } from "@/lib/utils";

type UserRow = { id: string; name: string; username: string; role: Role; canViewCost: boolean; active: boolean };

const col = tableColumns<UserRow>();
const columns = [
  col.accessor("name", { header: "Name", cell: (c) => <span className="font-medium">{c.getValue()}</span> }),
  col.accessor("username", { header: "Username" }),
  col.accessor((u) => ROLE_LABEL[u.role], { id: "role", header: "Role" }),
  col.accessor((u) => (u.canViewCost ? "Yes" : "No"), { id: "cost", header: "Sees cost", enableGlobalFilter: false }),
  col.accessor((u) => (u.active ? "Active" : "Disabled"), {
    id: "status",
    header: "Status",
    enableGlobalFilter: false,
    cell: (c) => (
      <span className={cn("inline-flex items-center gap-1.5", !c.row.original.active && "text-muted-foreground")}>
        <span aria-hidden className={cn("size-1.5 rounded-full", c.row.original.active ? "bg-green-600" : "bg-zinc-400")} />
        {c.getValue()}
      </span>
    ),
  }),
];

export function UsersTable({ users }: { users: UserRow[] }) {
  const router = useRouter();
  return (
    <DataTable
      data={users}
      columns={columns}
      status={(u) => (u.active ? "Active" : "Disabled")}
      searchPlaceholder="Search name or username"
      onRowClick={(u) => router.push(`/users/${u.id}`)}
    />
  );
}
