import Link from "next/link";
import { notFound } from "next/navigation";
import { DateText } from "@/components/date-text";
import { DocFacts } from "@/components/doc-share";
import { EmptyState } from "@/components/empty-state";
import { History } from "@/components/history";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/db";
import { expenseCategories } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { bpText, milliText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { getItem, SOURCE_LABEL } from "@/lib/stock";
import { cn } from "@/lib/utils";

const LABELS = {
  name: "Name",
  unit: "Unit",
  category_id: "Category",
  hsn_sac: "HSN / SAC",
  gst_bp: "GST %",
  opening_qty_milli: "Opening qty",
  opening_rate_paise: "Opening rate",
  active: "Active",
};

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2 whitespace-nowrap";

/** Where a move's document lives (adjustments; purchase bills from T18). */
function docHref(source: string, id: number): string | null {
  if (source === "adjustment") return "/stock-adjustments";
  if (source === "purchase") return `/purchase-bills/${id}`;
  return null;
}

export default async function ItemPage({ params }: PageProps<"/items/[id]">) {
  const user = await requirePermission("stockItems", "view");
  const id = Number((await params).id);
  const item = Number.isSafeInteger(id) ? await getItem(user, id) : undefined;
  if (!item) notFound();
  const cost = item.cost;
  const categories = cost ? await db.select({ id: expenseCategories.id, name: expenseCategories.name }).from(expenseCategories) : [];
  const unit = item.unit;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/items", label: "Items" }}
        title={item.name}
        description={[item.category, !item.active && "inactive"].filter(Boolean).join(" · ")}
        action={
          <div className="flex gap-2">
            {can(user, "stockAdjustment", "create") && item.active && (
              <Button asChild variant="outline">
                <Link href={`/stock-adjustments/new?item=${id}`}>Adjust stock</Link>
              </Button>
            )}
            {can(user, "stockItems", "edit") && (
              <Button asChild variant="outline">
                <Link href={`/items/${id}/edit`}>Edit</Link>
              </Button>
            )}
          </div>
        }
      />
      <DocFacts
        facts={[
          ["In stock", `${milliText(item.qty)} ${unit}`],
          ...(cost
            ? ([
                ["Average cost", cost.average === null ? null : <span key="a"><Money paise={cost.average} /> / {unit}</span>],
                ["Stock value", <Money key="v" paise={cost.value} />],
              ] as [string, React.ReactNode][])
            : []),
          ["HSN / SAC", item.hsnSac],
          ["GST %", item.gstBp === null ? null : `${bpText(item.gstBp)}%`],
        ]}
      />
      <Tabs defaultValue="card" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="card">Stock card ({item.moves.length})</TabsTrigger>
          {cost && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>
        <TabsContent value="card">
          {item.moves.length === 0 ? (
            <div className="rounded-lg border bg-card">
              <EmptyState title="No stock in or out yet." />
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border bg-card">
              <table className="w-full min-w-160 border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>Date</th>
                    <th className={th}>Entry</th>
                    <th className={th}>Document</th>
                    <th className={`${th} text-right`}>In</th>
                    <th className={`${th} text-right`}>Out</th>
                    <th className={`${th} text-right`}>Balance</th>
                    {cost && <th className={`${th} text-right`}>Value</th>}
                    {cost && <th className={`${th} text-right`}>Stock value</th>}
                  </tr>
                </thead>
                <tbody>
                  {item.moves.map((m) => {
                    const href = docHref(m.source, m.sourceId);
                    return (
                      <tr key={m.id} className={cn(m.reversal && "text-muted-foreground")}>
                        <td className={td}>
                          <DateText date={m.date} />
                        </td>
                        <td className={td}>
                          {SOURCE_LABEL[m.source]}
                          {m.reversal && " (reversed)"}
                          {m.job && <span className="text-muted-foreground"> · job {m.job}</span>}
                        </td>
                        <td className={`${td} tabular-nums`}>
                          {href && m.number && (m.source !== "purchase" || cost) ? (
                            <Link href={href} className="text-primary hover:underline">
                              {m.number}
                            </Link>
                          ) : (
                            (m.number ?? "")
                          )}
                        </td>
                        <td className={`${td} text-right tabular-nums`}>{m.qty > 0n ? milliText(m.qty) : ""}</td>
                        <td className={`${td} text-right tabular-nums`}>{m.qty < 0n ? milliText(-m.qty) : ""}</td>
                        <td className={`${td} text-right font-medium tabular-nums`}>
                          {milliText(m.balance)} {unit}
                        </td>
                        {"cost" in m && (
                          <td className={`${td} text-right`}>
                            <Money paise={m.cost.value} />
                          </td>
                        )}
                        {"cost" in m && (
                          <td className={`${td} text-right`}>
                            <Money paise={m.cost.balance} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
        {cost && (
          <TabsContent value="history">
            <History
              table="stock_items"
              rowId={id}
              labels={LABELS}
              hide={["created_by"]}
              display={{
                category_id: (v) => categories.find((c) => c.id === v)?.name ?? String(v),
                opening_qty_milli: (v) => milliText(BigInt(v as number)),
              }}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
