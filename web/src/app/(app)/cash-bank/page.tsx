import Link from "next/link";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { BANK_KEYS, CASH_KEYS, moneySummary, totalOf, type MoneyRow } from "@/lib/cash-bank";
import { can } from "@/lib/permissions";
import { LEDGER_PERIODS, rangeText, readRange } from "@/lib/statements";
import { LedgerFilter } from "../customers/[id]/ledger-filter";

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2 whitespace-nowrap";

/** S13: every money account for the period — opening + received − paid = closing — with the A§12 Cash / Bank totals. */
export default async function CashBankPage({ searchParams }: PageProps<"/cash-bank">) {
  const user = await requirePermission("books", "view");
  const q = await searchParams;
  const text = (key: string) => (typeof q[key] === "string" ? (q[key] as string) : "");
  const { period, range, error } = readRange(text("period") || "month", text("from"), text("to"));
  const rows = await moneySummary(range);
  const query = new URLSearchParams({ period, from: text("from"), to: text("to") }).toString();
  const group = (keys: readonly string[]) => rows.filter((r) => keys.includes(r.key ?? ""));
  const cash = group(CASH_KEYS);
  const bank = group(BANK_KEYS);
  const [cashTotal, bankTotal, all] = [totalOf(cash), totalOf(bank), totalOf(rows)];

  const figures = (r: Omit<MoneyRow, "id" | "code" | "name" | "key">) => (
    <>
      <td className={`${td} text-right`}>
        <Money paise={r.opening} />
      </td>
      <td className={`${td} text-right`}>
        <Money paise={r.received} />
      </td>
      <td className={`${td} text-right`}>
        <Money paise={r.paid} />
      </td>
      <td className={`${td} text-right font-medium`}>
        <Money paise={r.closing} />
      </td>
    </>
  );
  const accountRows = (list: MoneyRow[]) =>
    list.map((r) => (
      <tr key={r.id} className="hover:bg-muted/50">
        <td className={td}>
          <Link href={`/cash-bank/accounts/${r.id}?${query}`} className="text-primary hover:underline">
            {r.name}
          </Link>
        </td>
        {figures(r)}
      </tr>
    ));

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Cash & Bank"
        description="Every money account: opening + received − paid = closing, from the books."
        action={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href="/cash-bank/transfers">Transfers</Link>
            </Button>
            {can(user, "books", "create") && (
              <Button asChild>
                <Link href="/cash-bank/transfers/new">New transfer</Link>
              </Button>
            )}
          </div>
        }
      />
      <LedgerFilter action="/cash-bank" periods={Object.entries(LEDGER_PERIODS)} period={period} from={range.from} to={range.to} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error} Showing all entries.
        </p>
      )}

      <section aria-label="Closing balances" className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
        {[
          ["Cash", cashTotal.closing, "Cash + Petty Cash"],
          ["Bank", bankTotal.closing, "Bank 1 + Bank 2 + UPI"],
          ["Total", all.closing, rangeText(range)],
        ].map(([label, paise, note]) => (
          <div key={label as string} className="bg-card px-4 py-3.5">
            <p className="text-xs text-muted-foreground">{label as string}</p>
            <p className="mt-1 text-lg leading-7 font-medium tracking-tight tabular-nums sm:text-xl">
              <Money paise={paise as bigint} />
            </p>
            <p className="truncate text-xs text-muted-foreground">{note as string}</p>
          </div>
        ))}
      </section>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-160 border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr>
              <th className={th}>Account</th>
              <th className={`${th} text-right`}>Opening</th>
              <th className={`${th} text-right`}>Received</th>
              <th className={`${th} text-right`}>Paid</th>
              <th className={`${th} text-right`}>Closing</th>
            </tr>
          </thead>
          <tbody>
            {accountRows(cash)}
            <tr className="bg-muted/40 font-medium">
              <td className={td}>Cash total</td>
              {figures(cashTotal)}
            </tr>
            {accountRows(bank)}
            <tr className="bg-muted/40 font-medium">
              <td className={td}>Bank total</td>
              {figures(bankTotal)}
            </tr>
            <tr className="font-semibold">
              <td className={td}>Total</td>
              {figures(all)}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        A document cancelled or edited within the period (entry and reversal both inside it) is left out of Received and Paid; it never changes a closing.
      </p>
    </div>
  );
}
