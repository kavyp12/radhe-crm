import { pdfForToken, pdfResponse } from "@/lib/pdf";

// Public, no login (proxy.ts lets /share/* through): the random token (D46) is the key to exactly one PDF.
export async function GET(_request: Request, ctx: RouteContext<"/share/[token]">) {
  return pdfResponse(await pdfForToken((await ctx.params).token));
}
