import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { ReportActions } from "@/components/report-actions";
import { ReportFilters } from "@/components/report-filters";
import { ReportView } from "@/components/report-view";
import { requirePermission } from "@/lib/auth";
import { reportLoader } from "@/lib/exports";
import { reportFileName } from "@/lib/report";

/** One S20 report (/reports/<name>): filters, tables with totals and drill-down, Excel / PDF / Print / Share (D59). */
export default async function ReportPage({ params, searchParams }: PageProps<"/reports/[name]">) {
  const user = await requirePermission("salesReports", "view");
  const { name } = await params;
  const load = reportLoader(name);
  if (!load) notFound();
  const raw = await searchParams;
  const q = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const result = await load(user, q);
  if (!result) redirect("/reports"); // not this user's report (area or can_view_cost)
  const { report, period, periods, error, picks } = result;
  const query = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1])).toString();

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title={report.title}
        description={report.filters.join(" · ")}
        back={{ href: "/reports", label: "Reports" }}
        action={<ReportActions name={name} query={query} title={report.title} pdfName={reportFileName(report.title, report.generatedAt, "pdf")} />}
      />
      <ReportFilters periods={periods} period={period} from={q.from} to={q.to} picks={picks} />
      {error && <p className="text-sm text-red-700">{error}</p>}
      <ReportView tables={report.tables} />
    </div>
  );
}
