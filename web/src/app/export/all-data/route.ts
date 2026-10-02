import { PassThrough, Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { userFromHeaders } from "@/lib/auth";
import { canExportAll, exportAll } from "@/lib/data-export";
import { reportFileName } from "@/lib/report";

/** /export/all-data: every table as one Excel workbook (S27, T36), streamed as it is written. Owner with can_view_cost. */
export async function GET(request: NextRequest) {
  const user = await userFromHeaders(request.headers);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!canExportAll(user)) return Response.json({ error: "Not allowed" }, { status: 403 });

  const out = new PassThrough();
  exportAll(out).catch((error) => out.destroy(error)); // a failure mid-way aborts the download instead of ending it short
  return new Response(Readable.toWeb(out) as ReadableStream<Uint8Array>, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${reportFileName("Radhe CRM data", new Date(), "xlsx")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
