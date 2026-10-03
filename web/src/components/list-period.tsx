import { ReportFilters } from "@/components/report-filters";
import { LIST_PERIODS, type listPeriod } from "@/lib/statements";

/** A big list's period bar (D68): this FY by default, "All entries" on request; the rows come filtered from the server. */
export function ListPeriod({ period, from, to, error }: ReturnType<typeof listPeriod>) {
  return (
    <div className="grid gap-2">
      <ReportFilters periods={LIST_PERIODS} period={period} from={from} to={to} />
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
