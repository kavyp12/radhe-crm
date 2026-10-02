import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { StatusBadge, type Status } from "@/components/status-badge";

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2 whitespace-nowrap";

export type OpeningBillRow = { id: number; billNo: string; billDate: string; dueDate: string; amountPaise: bigint; open: bigint; payment: Status };

/** A customer's or vendor's opening bills (T43, imported dues on the books start date) with what is still open. */
export function OpeningBills({ rows }: { rows: OpeningBillRow[] }) {
  if (!rows.length) return null;
  return (
    <section aria-label="Opening bills" className="overflow-x-auto rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-medium">Opening bills</h2>
        <p className="text-xs text-muted-foreground">Dues brought in on the books start date, bill by bill.</p>
      </div>
      <table className="w-full min-w-140 border-separate border-spacing-0 text-[13px]">
        <thead>
          <tr>
            <th className={th}>Bill no</th>
            <th className={th}>Bill date</th>
            <th className={th}>Due</th>
            <th className={th}>Payment</th>
            <th className={`${th} text-right`}>Amount</th>
            <th className={`${th} text-right`}>Open</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td className={`${td} font-medium tabular-nums`}>{b.billNo}</td>
              <td className={td}>
                <DateText date={b.billDate} />
              </td>
              <td className={td}>
                <DateText date={b.dueDate} />
              </td>
              <td className={td}>
                <StatusBadge status={b.payment} />
              </td>
              <td className={`${td} text-right`}>
                <Money paise={b.amountPaise} />
              </td>
              <td className={`${td} text-right`}>
                <Money paise={b.open} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
