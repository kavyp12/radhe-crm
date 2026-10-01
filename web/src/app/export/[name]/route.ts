import type { NextRequest } from "next/server";
import { userFromHeaders } from "@/lib/auth";
import { reportXlsx } from "@/lib/excel";
import { EXPORTS } from "@/lib/exports";
import { reportPdf } from "@/lib/pdf";
import { reportFileName } from "@/lib/report";

/** /export/<report or list>?format=xlsx|pdf&<the page's filters>: the same rows the user's page shows (S27, D59). */
export async function GET(request: NextRequest, ctx: RouteContext<"/export/[name]">) {
  const user = await userFromHeaders(request.headers);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const { name } = await ctx.params;
  const load = Object.hasOwn(EXPORTS, name) ? EXPORTS[name] : undefined;
  if (!load) return new Response("Not found", { status: 404 });
  const q = request.nextUrl.searchParams;
  const report = await load(user, Object.fromEntries(q));
  if (!report) return Response.json({ error: "Not allowed" }, { status: 403 });

  const pdf = q.get("format") === "pdf";
  const bytes = pdf ? await reportPdf(report) : await reportXlsx(report);
  const fileName = reportFileName(report.title, report.generatedAt, pdf ? "pdf" : "xlsx");
  return new Response(new Blob([new Uint8Array(bytes)]), {
    headers: {
      "Content-Type": pdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      // PDF inline so Print can open it in the browser's viewer; the PDF button downloads via <a download>.
      "Content-Disposition": `${pdf ? "inline" : "attachment"}; filename="${fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
