import type { NextRequest } from "next/server";
import { userFromHeaders } from "@/lib/auth";
import { pdfResponse, purchaseOrderPdf } from "@/lib/pdf";
import { can, canViewCost } from "@/lib/permissions";

export async function GET(request: NextRequest, ctx: RouteContext<"/purchase-orders/[id]/pdf">) {
  const user = await userFromHeaders(request.headers);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!can(user, "purchaseOrders", "view") || !canViewCost(user)) return Response.json({ error: "Not allowed" }, { status: 403 });
  const id = Number((await ctx.params).id);
  return pdfResponse(Number.isSafeInteger(id) ? await purchaseOrderPdf(id) : null);
}
