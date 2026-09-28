import type { NextRequest } from "next/server";
import { readAttachment } from "@/lib/attachments";
import { userFromHeaders } from "@/lib/auth";

// Serves an attachment to a signed-in user who may see its record. Files never live under /public.
export async function GET(request: NextRequest, ctx: RouteContext<"/api/files/[id]">) {
  const user = await userFromHeaders(request.headers);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const id = Number((await ctx.params).id);
  const file = Number.isSafeInteger(id) ? await readAttachment(user, id) : null;
  if (!file) return Response.json({ error: "Not found" }, { status: 404 });

  const ascii = file.row.fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(new Blob([file.bytes as Uint8Array<ArrayBuffer>]), {
    headers: {
      "Content-Type": file.row.mime,
      "Content-Disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.row.fileName)}`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
