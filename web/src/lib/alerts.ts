import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, purchaseBills, vendors } from "@/db/schema";
import { pendingCount } from "@/lib/approvals";
import { formatDate, todayIST } from "@/lib/dates";
import { openPromises } from "@/lib/follow-ups";
import { pendingRequestCount } from "@/lib/material-requests";
import { formatMoney } from "@/lib/num";
import { outstanding } from "@/lib/outstanding";
import { can, type SessionUser } from "@/lib/permissions";
import { paidByBill } from "@/lib/vendor-payments";

// Alerts (S8, S25, D22, D57): queries run when a page loads — no background worker, no SMS / WhatsApp. Each user gets
// only the alerts of areas they can open: customer money (due today, overdue, credit limit) for whoever can open
// outstanding; promises for follow-ups; vendor bills for vendor payments; pending approvals for the owner.
// ponytail: recomputed on every page load (the bell is in the layout); cache per request / minute if it gets slow.

export const ALERT_KINDS = {
  due_today: "Payment due today",
  overdue: "Payment overdue",
  promise_due: "Promise due today",
  promise_broken: "Promise broken",
  vendor_due: "Vendor payment due",
  credit_limit: "Credit limit exceeded",
  approvals: "Pending approvals",
} as const;
export type AlertKind = keyof typeof ALERT_KINDS;
export type Alert = { kind: AlertKind; key: string; title: string; detail: string; href: string; amount?: bigint };

const docs = (n: number) => (n === 1 ? "1 document" : `${n} documents`);

export async function alertsFor(user: SessionUser, today = todayIST()): Promise<Alert[]> {
  const out: Alert[] = [];

  if (can(user, "salesReports", "view")) {
    const [report, limits] = await Promise.all([
      outstanding(today),
      db.select({ id: customers.id, limit: customers.creditLimitPaise }).from(customers).where(isNotNull(customers.creditLimitPaise)),
    ]);
    for (const c of report.customers) {
      const href = `/outstanding?customer=${c.id}`;
      const dueToday = c.docs.filter((d) => d.due === "today");
      const overdue = c.docs.filter((d) => d.due === "overdue");
      if (dueToday.length) {
        const numbers = dueToday.map((d) => d.number).join(", ");
        out.push({ kind: "due_today", key: `due:${c.id}`, title: c.name, detail: `${docs(dueToday.length)} due today: ${numbers}`, href, amount: c.totals.dueToday });
      }
      if (overdue.length) {
        const late = Math.max(...overdue.map((d) => d.age));
        out.push({ kind: "overdue", key: `overdue:${c.id}`, title: c.name, detail: `${docs(overdue.length)} past due · oldest ${late} days old`, href, amount: c.totals.overdue });
      }
      const limit = limits.find((l) => l.id === c.id)?.limit;
      if (limit != null && c.totals.total > limit) {
        out.push({
          kind: "credit_limit",
          key: `limit:${c.id}`,
          title: c.name,
          detail: `${formatMoney(c.totals.total)} due, limit ${formatMoney(limit)}`,
          href: `/customers/${c.id}`,
          amount: c.totals.total - limit,
        });
      }
    }
  }

  if (can(user, "followUps", "view")) {
    for (const p of await openPromises(today)) {
      const kind = p.promise === "Broken" ? "promise_broken" : "promise_due";
      const promised = `${formatMoney(p.expected!)} promised for ${formatDate(p.promiseDate!)}`;
      out.push({
        kind,
        key: `promise:${p.id}`,
        title: p.customer,
        detail: `${promised} · ${formatMoney(p.received)} received since · ${p.person}`,
        href: `/follow-ups?customer=${p.customerId}`,
        amount: p.expected! - p.received,
      });
    }
  }

  if (can(user, "payments", "view")) {
    const paid = paidByBill();
    const bills = await db
      .select({
        vendorId: purchaseBills.vendorId,
        vendor: vendors.name,
        dueDate: purchaseBills.dueDate,
        open: sql<string>`${purchaseBills.totalPaise} - coalesce(${paid.paise}, 0)`,
      })
      .from(purchaseBills)
      .innerJoin(vendors, eq(vendors.id, purchaseBills.vendorId))
      .leftJoin(paid, eq(paid.billId, purchaseBills.id))
      .where(and(eq(purchaseBills.status, "active"), sql`${purchaseBills.dueDate} <= ${today}`, sql`${purchaseBills.totalPaise} > coalesce(${paid.paise}, 0)`));
    const byVendor = new Map<number, { vendor: string; n: number; open: bigint; overdue: boolean }>();
    for (const b of bills) {
      const v = byVendor.get(b.vendorId) ?? { vendor: b.vendor, n: 0, open: 0n, overdue: false };
      v.n += 1;
      v.open += BigInt(b.open);
      v.overdue ||= b.dueDate < today;
      byVendor.set(b.vendorId, v);
    }
    for (const [id, v] of byVendor) {
      const bills = v.n === 1 ? "1 bill" : `${v.n} bills`;
      out.push({ kind: "vendor_due", key: `vendor:${id}`, title: v.vendor, detail: `${bills} ${v.overdue ? "overdue" : "due today"}`, href: `/vendors/${id}`, amount: v.open });
    }
  }

  if (can(user, "approvals", "approve")) {
    const n = (await pendingCount()) + (await pendingRequestCount());
    if (n) out.push({ kind: "approvals", key: "approvals", title: n === 1 ? "1 request waiting" : `${n} requests waiting`, detail: "Approvals and material requests", href: "/approvals" });
  }

  const order = Object.keys(ALERT_KINDS);
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}
