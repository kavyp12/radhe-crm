import type { NextRequest } from "next/server";
import { userFromHeaders } from "@/lib/auth";
import { pdfResponse, statementPdf } from "@/lib/pdf";
import { can } from "@/lib/permissions";
import { readRange } from "@/lib/statements";

/** The statement PDF for ?period= (or custom ?from= / ?to=, DD/MM/YYYY): signed-in users who see customer amounts. */
export async function GET(request: NextRequest, ctx: RouteContext<"/customers/[id]/statement">) {
  const user = await userFromHeaders(request.headers);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!can(user, "customers", "money")) return Response.json({ error: "Not allowed" }, { status: 403 });
  const id = Number((await ctx.params).id);
  const q = request.nextUrl.searchParams;
  const { range, error } = readRange(q.get("period") ?? undefined, q.get("from") ?? undefined, q.get("to") ?? undefined);
  if (error) return Response.json({ error }, { status: 400 });
  return pdfResponse(Number.isSafeInteger(id) ? await statementPdf(id, range) : null);
}
