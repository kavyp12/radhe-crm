import type { NextRequest } from "next/server";
import { userFromHeaders } from "@/lib/auth";
import { invoicePdf, pdfResponse } from "@/lib/pdf";
import { can } from "@/lib/permissions";

export async function GET(request: NextRequest, ctx: RouteContext<"/invoices/[id]/pdf">) {
  const user = await userFromHeaders(request.headers);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!can(user, "invoices", "view")) return Response.json({ error: "Not allowed" }, { status: 403 });
  const id = Number((await ctx.params).id);
  return pdfResponse(Number.isSafeInteger(id) ? await invoicePdf(id) : null);
}
