import { and, desc, eq } from "drizzle-orm";
import { Clock } from "lucide-react";
import { DateText } from "@/components/date-text";
import { EmptyState } from "@/components/empty-state";
import { db } from "@/db";
import { auditLog, users } from "@/db/schema";
import { formatDateTime } from "@/lib/dates";
import { bpText } from "@/lib/num";

// History tab (S23): who changed what and when, read from audit_log. Server component; the page that shows it
// has already checked the user may see the record.

type Props = {
  table: string;
  rowId: string | number;
  /** Column → label; other columns are shown as "Snake case" → "Snake case". */
  labels?: Record<string, string>;
  /** Columns never shown (id, created_at and updated_at never are). */
  hide?: string[];
};

const ALWAYS_HIDDEN = ["id", "created_at", "updated_at"];

function show(column: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (column.endsWith("_bp") && typeof value === "number") return `${bpText(value)}%`;
  if (column.endsWith("_attachment_id")) return `file #${value}`;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return formatDateTime(new Date(value));
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

const VERB = { insert: "created this", update: "made changes", delete: "deleted this" } as const;

export async function History({ table, rowId, labels = {}, hide = [] }: Props) {
  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      oldData: auditLog.oldData,
      newData: auditLog.newData,
      at: auditLog.at,
      user: users.name,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.userId, users.id))
    .where(and(eq(auditLog.tableName, table), eq(auditLog.rowId, String(rowId))))
    .orderBy(desc(auditLog.id))
    .limit(200);

  if (!rows.length) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState icon={Clock} title="No changes recorded yet." />
      </div>
    );
  }

  const hidden = new Set([...ALWAYS_HIDDEN, ...hide]);
  const label = (column: string) =>
    labels[column] ?? column.charAt(0).toUpperCase() + column.slice(1).replaceAll("_", " ");

  return (
    <ol className="divide-y rounded-lg border bg-card">
      {rows.map((row) => {
        const before = row.oldData ?? {};
        const after = row.newData ?? {};
        const columns = Object.keys({ ...before, ...after }).filter(
          (c) =>
            !hidden.has(c) &&
            JSON.stringify(before[c]) !== JSON.stringify(after[c]) &&
            (row.action !== "insert" || (after[c] !== null && after[c] !== "")),
        );
        return (
          <li key={row.id} className="grid gap-2 px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-sm">
              <p>
                <span className="font-medium">{row.user ?? "System"}</span>{" "}
                <span className="text-muted-foreground">{VERB[row.action]}</span>
              </p>
              <span className="text-xs text-muted-foreground">
                <DateText at={row.at} />
              </span>
            </div>
            {columns.length > 0 && (
              <dl className="grid gap-1 text-[13px]">
                {columns.map((c) => (
                  <div key={c} className="grid grid-cols-[minmax(6rem,11rem)_minmax(0,1fr)] gap-3">
                    <dt className="text-muted-foreground">{label(c)}</dt>
                    <dd className="break-words whitespace-pre-line">
                      {row.action === "update" && (
                        <>
                          <span className="text-muted-foreground">{show(c, before[c])}</span>
                          <span aria-label="changed to"> → </span>
                        </>
                      )}
                      {show(c, row.action === "delete" ? before[c] : after[c])}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        );
      })}
    </ol>
  );
}
