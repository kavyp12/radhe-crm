import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DateText } from "@/components/date-text";
import { DocFacts } from "@/components/doc-share";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { DocNumber } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { ledger } from "@/lib/ledger";
import { can } from "@/lib/permissions";
import { entryLabel, LEDGER_PERIODS, rangeText, readRange } from "@/lib/statements";
import { LedgerFilter } from "../../../customers/[id]/ledger-filter";

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2 whitespace-nowrap";

/** Where a money account's journal line comes from (owner / accountant may open all of these). */
function docHref(docType: string, docId: number, date: string, accountKey: string | null): string | null {
  if (docType === "receipts") return `/receipts/${docId}`;
  if (docType === "vendor_payments") return `/vendor-payments/${docId}`;
  if (docType === "expenses") return `/expenses/${docId}`;
  if (docType === "transfers") return `/cash-bank/transfers/${docId}`;
  if (docType === "adjustments") return `/journal-vouchers/${docId}`;
  if (docType === "cash_counts" && accountKey) return `/cash-book?date=${formatDate(date)}&account=${accountKey}`;
  return null;
}

/** An account book (S13): the money account's journal lines for the period with a running balance. */
export default async function AccountBookPage({ params, searchParams }: PageProps<"/cash-bank/accounts/[id]">) {
  const user = await requirePermission("books", "view");
  const id = Number((await params).id);
  const [account] = Number.isSafeInteger(id)
    ? await db.select().from(accounts).where(and(eq(accounts.id, id), eq(accounts.isMoney, true)))
    : [];
  if (!account) notFound();
  const q = await searchParams;
  const text = (key: string) => (typeof q[key] === "string" ? (q[key] as string) : "");
  const { period, range, error } = readRange(text("period") || "month", text("from"), text("to"));
  const book = await ledger({ account: id }, range.from ?? undefined, range.to ?? undefined);
  const sum = (side: "debit" | "credit") => book.rows.reduce((s, r) => s + r[side], 0n);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: `/cash-bank?${new URLSearchParams({ period, from: text("from"), to: text("to") })}`, label: "Cash & Bank" }}
        title={account.name}
        description="Account book: every entry on this account, with the running balance."
        action={
          can(user, "books", "create") ? (
            <Button asChild variant="outline">
              <Link href={`/cash-bank/transfers/new?from=${id}`}>Transfer out</Link>
            </Button>
          ) : undefined
        }
      />
      <LedgerFilter action={`/cash-bank/accounts/${id}`} periods={Object.entries(LEDGER_PERIODS)} period={period} from={range.from} to={range.to} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error} Showing all entries.
        </p>
      )}
      <DocFacts
        facts={[
          ["Period", rangeText(range)],
          ["Opening balance", <Money key="o" paise={book.opening} />],
          ["In (Dr) / out (Cr)", <span key="t"><Money paise={sum("debit")} /> / <Money paise={sum("credit")} /></span>],
          ["Closing balance", <Money key="c" paise={book.closing} />],
        ]}
      />
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-180 border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr>
              <th className={th}>Date</th>
              <th className={th}>Document</th>
              <th className={th}>Particulars</th>
              <th className={`${th} text-right`}>In (Dr)</th>
              <th className={`${th} text-right`}>Out (Cr)</th>
              <th className={`${th} text-right`}>Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr className="font-medium">
              <td className={td}>{range.from && <DateText date={range.from} />}</td>
              <td className={td} />
              <td className={td}>Opening balance</td>
              <td className={td} />
              <td className={td} />
              <td className={`${td} text-right`}>
                <Money paise={book.opening} />
              </td>
            </tr>
            {book.rows.map((r, i) => {
              const href = docHref(r.docType, r.docId, r.date, account.systemKey);
              return (
                <tr key={i}>
                  <td className={td}>
                    <DateText date={r.date} />
                  </td>
                  <td className={td}>
                    {r.number && href ? (
                      <Link href={href} className="text-primary hover:underline">
                        <DocNumber number={r.number} />
                      </Link>
                    ) : r.number ? (
                      <DocNumber number={r.number} />
                    ) : href ? (
                      <Link href={href} className="text-primary hover:underline">
                        Open
                      </Link>
                    ) : null}
                  </td>
                  <td className="max-w-96 truncate border-b px-3 py-2" title={r.narration ?? undefined}>
                    {r.narration ?? entryLabel(r)}
                  </td>
                  <td className={`${td} text-right`}>{r.debit ? <Money paise={r.debit} /> : null}</td>
                  <td className={`${td} text-right`}>{r.credit ? <Money paise={r.credit} /> : null}</td>
                  <td className={`${td} text-right`}>
                    <Money paise={r.balance} />
                  </td>
                </tr>
              );
            })}
            <tr className="font-medium">
              <td className={td} />
              <td className={td} />
              <td className={td}>Closing balance</td>
              <td className={`${td} text-right`}>
                <Money paise={sum("debit")} />
              </td>
              <td className={`${td} text-right`}>
                <Money paise={sum("credit")} />
              </td>
              <td className={`${td} text-right`}>
                <Money paise={book.closing} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
