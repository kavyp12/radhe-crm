import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { DocNumber } from "@/components/status-badge";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import { CHAIN_STEPS, purchaseChain, type ChainStep } from "@/lib/purchase-chain";

// The purchase chain on every MR, PO, GRN, bill and vendor payment (S18, R0): each step's documents, linked for users
// who may open them (PO, GRN and bill pages need can_view_cost). Numbers only, never amounts.

const STEP: Record<ChainStep, { label: string; href: string; opens: (u: SessionUser) => boolean }> = {
  request: { label: "Material request", href: "/material-requests", opens: (u) => can(u, "materialRequests", "view") },
  order: { label: "Purchase order", href: "/purchase-orders", opens: (u) => can(u, "purchaseOrders", "view") && canViewCost(u) },
  receipt: { label: "Material receive", href: "/material-receive", opens: (u) => can(u, "goodsReceipts", "view") && canViewCost(u) },
  bill: { label: "Purchase bill", href: "/purchase-bills", opens: (u) => can(u, "books", "view") && canViewCost(u) },
  payment: { label: "Payment", href: "/vendor-payments", opens: (u) => can(u, "payments", "view") },
};

export async function PurchaseChain({ user, step, id }: { user: SessionUser; step: ChainStep; id: number }) {
  const chain = await purchaseChain(step, id);
  return (
    <nav aria-label="Purchase chain" className="rounded-lg border bg-card px-4 py-3">
      <ol className="flex flex-wrap items-start gap-x-2 gap-y-3 text-[13px]">
        {CHAIN_STEPS.map((s, i) => (
          <li key={s} className="flex items-start gap-2">
            {i > 0 && <ChevronRight aria-hidden className="mt-4 size-4 shrink-0 text-muted-foreground" />}
            <div className="grid min-w-24 gap-0.5">
              <span className="text-xs text-muted-foreground">{STEP[s].label}</span>
              {chain[s].length === 0 && <span className="text-muted-foreground">—</span>}
              {chain[s].map((d) => {
                const here = s === step && d.id === id;
                const number = <DocNumber number={d.number} status={d.cancelled ? "Cancelled" : undefined} />;
                return (
                  <span key={d.id} aria-current={here ? "page" : undefined} className={here ? "rounded bg-muted px-1 -mx-1" : undefined}>
                    {here || !STEP[s].opens(user) ? (
                      number
                    ) : (
                      <Link href={`${STEP[s].href}/${d.id}`} className="text-primary hover:underline">
                        {number}
                      </Link>
                    )}
                  </span>
                );
              })}
            </div>
          </li>
        ))}
      </ol>
    </nav>
  );
}
