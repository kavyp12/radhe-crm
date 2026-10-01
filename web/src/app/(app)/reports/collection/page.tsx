import { PageHeader } from "@/components/page-header";
import { ReportActions } from "@/components/report-actions";
import { ReportFilters } from "@/components/report-filters";
import { ReportView } from "@/components/report-view";
import { requirePermission } from "@/lib/auth";
import { reportFileName } from "@/lib/report";
import { collectionReport, REPORT_PERIODS } from "@/lib/reports";

/** S20 #2: receipts in the period by date, customer, mode, money account and receiver, with totals by mode. */
export default async function CollectionReportPage({ searchParams }: PageProps<"/reports/collection">) {
  const user = await requirePermission("reports", "view");
  const raw = await searchParams;
  const q = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const { report, period, error, picks } = (await collectionReport(user, q))!;
  const query = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1])).toString();

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Collection report"
        description={report.filters.join(" · ")}
        back={{ href: "/reports", label: "Reports" }}
        action={<ReportActions name="collection" query={query} title={report.title} pdfName={reportFileName(report.title, report.generatedAt, "pdf")} />}
      />
      <ReportFilters periods={REPORT_PERIODS} period={period} from={q.from} to={q.to} picks={picks} />
      {error && <p className="text-sm text-red-700">{error}</p>}
      <ReportView tables={report.tables} />
    </div>
  );
}
