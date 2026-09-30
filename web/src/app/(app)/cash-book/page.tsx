import { eq } from "drizzle-orm";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Form from "next/form";
import Link from "next/link";
import { DateInput } from "@/components/date-input";
import { DateText } from "@/components/date-text";
import { ActionDialog } from "@/components/doc-actions";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { DocNumber } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { cashBook } from "@/lib/cash-book";
import { moneyDocHref } from "@/lib/cash-bank";
import { addDays, formatDate, parseDate, todayIST } from "@/lib/dates";
import { formatMoney } from "@/lib/num";
import { can } from "@/lib/permissions";
import { postDifferenceAction, saveCountAction } from "./actions";
import { CountForm } from "./count-form";

const td = "border-b px-4 py-2";

/** S14: one day of the Cash account (Petty Cash selectable) — opening, the day's groups, closing — and the cash count. */
export default async function CashBookPage({ searchParams }: PageProps<"/cash-book">) {
  const user = await requirePermission("books", "view");
  const q = await searchParams;
  const text = (key: string) => (typeof q[key] === "string" ? (q[key] as string).trim() : "");
  let date = todayIST();
  let error: string | null = null;
  if (text("date")) {
    try {
      date = parseDate(text("date"));
    } catch {
      error = "Use DD/MM/YYYY for the date, e.g. 30/09/2026. Showing today.";
    }
  }
  const key = text("account") === "petty_cash" ? "petty_cash" : "cash";
  const [account] = await db.select().from(accounts).where(eq(accounts.systemKey, key));
  const book = await cashBook(account.id, date);
  const dayLink = (d: string) => `/cash-book?date=${formatDate(d)}&account=${key}`;
  const count = book.count;
  const isOwner = can(user, "approvals", "approve");
  const short = count && count.difference < 0n;
  const gap = count ? formatMoney(count.difference < 0n ? -count.difference : count.difference) : "";

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader title="Cash book" description="One day of cash: what came in, what went out, and the count at day end." />

      <div className="flex flex-wrap items-start gap-2">
        <Form action="/cash-book" className="flex flex-wrap items-start gap-2">
          <NativeSelect name="account" aria-label="Account" defaultValue={key}>
            <NativeSelectOption value="cash">Cash</NativeSelectOption>
            <NativeSelectOption value="petty_cash">Petty Cash</NativeSelectOption>
          </NativeSelect>
          <DateInput name="date" aria-label="Date" defaultValue={date} className="w-32" />
          <Button type="submit" variant="outline">
            Show
          </Button>
        </Form>
        <div className="flex gap-1">
          <Button asChild variant="ghost" size="icon" aria-label="Previous day">
            <Link href={dayLink(addDays(date, -1))}>
              <ChevronLeft />
            </Link>
          </Button>
          <Button asChild variant="ghost" size="icon" aria-label="Next day">
            <Link href={dayLink(addDays(date, 1))}>
              <ChevronRight />
            </Link>
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <section aria-label={`${account.name} on ${formatDate(date)}`} className="overflow-hidden rounded-lg border bg-card text-sm">
        <div className="flex items-center justify-between gap-4 border-b bg-muted/40 px-4 py-3 font-medium">
          <span>
            Opening {account.name.toLowerCase()} · <DateText date={date} />
          </span>
          <Money paise={book.opening} />
        </div>
        {book.groups.map((g) => (
          <details key={g.key} className="group border-b">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 hover:bg-muted/40">
              <span className="flex items-center gap-2">
                <ChevronRight aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
                {g.label}
                <span className="text-xs text-muted-foreground">({g.entries.length})</span>
              </span>
              <Money paise={g.total} />
            </summary>
            {g.entries.length === 0 ? (
              <p className="px-4 pb-3 pl-10 text-xs text-muted-foreground">Nothing this day.</p>
            ) : (
              <div className="overflow-x-auto pb-2">
                <table className="w-full min-w-120 border-separate border-spacing-0 text-[13px]">
                  <tbody>
                    {g.entries.map((e) => {
                      const href = moneyDocHref(e.docType, e.docId);
                      return (
                        <tr key={`${e.entryId}:${e.amount}`} className={e.reversal ? "text-muted-foreground" : undefined}>
                          <td className={`${td} w-40 pl-10 whitespace-nowrap`}>
                            {e.number && href ? (
                              <Link href={href} className="text-primary hover:underline">
                                <DocNumber number={e.number} />
                              </Link>
                            ) : (
                              e.number
                            )}
                          </td>
                          <td className={td}>{e.narration}</td>
                          <td className={`${td} text-right whitespace-nowrap`}>
                            <Money paise={e.amount} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        ))}
        <div className="flex items-center justify-between gap-4 bg-muted/40 px-4 py-3 font-medium">
          <span>Closing {account.name.toLowerCase()}</span>
          <Money paise={book.closing} />
        </div>
      </section>

      <section aria-label="Cash count" className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-medium">Cash count</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Count the cash in hand and save it. The difference from the book closing shows here; posting it moves it to Cash Short / Excess.
          </p>
        </div>
        <div className="grid gap-4 p-4">
          {count ? (
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <div className="grid gap-0.5">
                <dt className="text-xs text-muted-foreground">Counted</dt>
                <dd>
                  <Money paise={count.countedPaise} />
                  <span className="block text-xs text-muted-foreground">
                    by {count.countedByName}, <DateText at={count.countedAt} />
                  </span>
                </dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="text-xs text-muted-foreground">Book closing</dt>
                <dd>
                  <Money paise={book.closing} />
                </dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="text-xs text-muted-foreground">Difference</dt>
                <dd className={count.difference === 0n ? undefined : short ? "font-medium text-red-600" : "font-medium text-green-700"}>
                  {count.difference === 0n ? "Matches the book" : `${short ? "−" : "+"}${gap} (${short ? "short" : "excess"})`}
                  {count.posted && <span className="block text-xs font-normal text-muted-foreground">Difference posted</span>}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">No count for this day yet.</p>
          )}
          {count && !count.posted && count.difference !== 0n && can(user, "books", "create") && (
            <div>
              <ActionDialog
                action={postDifferenceAction.bind(null, count.id)}
                label="Post difference"
                title={`Post ${gap} ${short ? "short" : "excess"}?`}
                description={
                  <>
                    Dated {formatDate(date)}: {short ? `Dr Cash Short / Excess, Cr ${account.name}` : `Dr ${account.name}, Cr Cash Short / Excess`}, {gap}. The
                    book then matches the count.
                    {!isOwner && " This goes to the owner for approval."}
                  </>
                }
                confirmLabel={isOwner ? "Post difference" : "Ask the owner"}
                done="Posted."
                reason={!isOwner}
              />
            </div>
          )}
          {can(user, "books", "create") && <CountForm action={saveCountAction.bind(null, account.id, formatDate(date))} />}
        </div>
      </section>
    </div>
  );
}
