import { cn } from "@/lib/utils";

// DESIGN.md "Status colours": one badge everywhere; the text is always there, colour is never the only signal.
export const STATUSES = [
  "Draft",
  "Sent",
  "Approved",
  "Issued",
  "In Production",
  "Ready",
  "Delivered",
  "Invoiced",
  "Part Payment",
  "Paid",
  "Unpaid",
  "Overdue",
  "Credit Customer",
  "Pending approval",
  "Rejected",
  "Cancelled",
] as const;
export type Status = (typeof STATUSES)[number];

const TONE: Record<Status, string> = {
  Draft: "bg-zinc-100 text-zinc-700 ring-zinc-500/20",
  Sent: "bg-blue-50 text-blue-700 ring-blue-600/20",
  Approved: "bg-violet-50 text-violet-700 ring-violet-600/20",
  Issued: "bg-sky-50 text-sky-800 ring-sky-600/25", // an invoice until T13 shows its payment status
  "In Production": "bg-amber-50 text-amber-800 ring-amber-600/25",
  Ready: "bg-cyan-50 text-cyan-800 ring-cyan-600/25",
  Delivered: "bg-teal-50 text-teal-800 ring-teal-600/25",
  Invoiced: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  "Part Payment": "bg-yellow-50 text-yellow-800 ring-yellow-600/30",
  Paid: "bg-green-50 text-green-700 ring-green-600/20",
  Unpaid: "bg-red-50 text-red-700 ring-red-600/20",
  Overdue: "bg-red-50 text-red-700 ring-red-600/20",
  "Credit Customer": "bg-blue-50 text-blue-700 ring-blue-600/20",
  "Pending approval": "bg-orange-50 text-orange-800 ring-orange-600/25",
  Rejected: "bg-red-50 text-red-700 ring-red-600/20",
  Cancelled: "bg-zinc-100 text-zinc-500 ring-zinc-500/20",
};

export function StatusBadge({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        TONE[status],
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current opacity-70" />
      {status}
    </span>
  );
}

/** A document number; a cancelled one is grey and struck through. */
export function DocNumber({ number, status }: { number: string; status?: Status }) {
  return (
    <span className={cn("font-medium tabular-nums", status === "Cancelled" && "text-muted-foreground line-through")}>
      {number}
    </span>
  );
}
