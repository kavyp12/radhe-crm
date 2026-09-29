import type { NextRequest } from "next/server";
import { userFromHeaders } from "@/lib/auth";
import { kindOfPath } from "@/lib/notes";
import { notePdf, pdfResponse } from "@/lib/pdf";
import { can } from "@/lib/permissions";

export async function GET(request: NextRequest, ctx: RouteContext<"/credit-debit-notes/[kind]/[id]/pdf">) {
  const user = await userFromHeaders(request.headers);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!can(user, "invoices", "view")) return Response.json({ error: "Not allowed" }, { status: 403 });
  const { kind: path, id: raw } = await ctx.params;
  const kind = kindOfPath(path);
  const id = Number(raw);
  return pdfResponse(kind && Number.isSafeInteger(id) ? await notePdf(kind, id) : null);
}
