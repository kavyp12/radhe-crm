import { TotalsPanel } from "@/components/line-items";
import { Money } from "@/components/money";
import { sizeText, type lineTotals } from "@/lib/lines";
import { amountInWords, bpText, milliText, type GstMode } from "@/lib/num";

// A sales document's lines, read-only (detail pages). Without `totals` (production, A§8) only what to make is shown:
// the loader has already left the money out.

export type ViewLine = {
  id: number;
  category: string;
  description: string | null;
  hsnSac: string | null;
  widthMilli: bigint | null;
  heightMilli: bigint | null;
  qtyMilli: bigint;
  unit: string;
  ratePaise?: bigint;
  discountPaise?: bigint;
  gstBp?: number;
};

type Totals = ReturnType<typeof lineTotals>;

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2 align-top";

export function DocLines({
  lines,
  totals,
  mode,
  after,
}: {
  lines: ViewLine[];
  totals?: Totals;
  mode?: GstMode;
  /** Rows under the total (an invoice's Advance adjusted / Balance). */
  after?: { label: string; paise: bigint; strong?: boolean }[];
}) {
  const money = !!totals;
  const gst = money && mode !== "estimate";
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[640px] border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr>
              <th className={`${th} w-8 text-right`}>#</th>
              <th className={th}>Item</th>
              <th className={th}>HSN/SAC</th>
              <th className={`${th} text-right`}>Qty</th>
              {money && <th className={`${th} text-right`}>Rate</th>}
              {money && <th className={`${th} text-right`}>Disc.</th>}
              {gst && <th className={`${th} text-right`}>GST %</th>}
              {money && <th className={`${th} text-right`}>Amount</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id}>
                <td className={`${td} text-right text-muted-foreground tabular-nums`}>{i + 1}</td>
                <td className={td}>
                  <div className="font-medium">{l.description ?? l.category}</div>
                  <div className="text-xs text-muted-foreground">
                    {[l.description && l.category, sizeText(l.widthMilli, l.heightMilli)].filter(Boolean).join(" · ")}
                  </div>
                </td>
                <td className={`${td} tabular-nums`}>{l.hsnSac ?? "—"}</td>
                <td className={`${td} text-right whitespace-nowrap tabular-nums`}>
                  {milliText(l.qtyMilli)} {l.unit}
                </td>
                {money && (
                  <td className={`${td} text-right`}>
                    <Money paise={l.ratePaise!} />
                  </td>
                )}
                {money && (
                  <td className={`${td} text-right`}>{l.discountPaise ? <Money paise={l.discountPaise} /> : "—"}</td>
                )}
                {gst && <td className={`${td} text-right tabular-nums`}>{bpText(l.gstBp!)}</td>}
                {money && (
                  <td className={`${td} text-right`}>
                    <Money paise={totals.lines[i].taxable} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totals && (
        <TotalsPanel
          rows={[
            { label: mode === "estimate" ? "Sub total" : "Taxable value", paise: totals.taxable },
            ...(mode === "same_state"
              ? [
                  { label: "CGST", paise: totals.cgst },
                  { label: "SGST", paise: totals.sgst },
                ]
              : mode === "other_state"
                ? [{ label: "IGST", paise: totals.igst }]
                : []),
            { label: "Round off", paise: totals.roundOff },
          ]}
          total={totals.total}
          words={amountInWords(totals.total < 0n ? 0n : totals.total)}
          after={after}
        />
      )}
    </div>
  );
}
