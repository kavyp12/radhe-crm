import { AgentError, agentRoute, thumbnailFromAgent } from "@/lib/agent";
import { MAX_UPLOAD_BYTES } from "@/lib/attachment-kinds";

// POST /api/agent/print-jobs/<id>/thumbnail (docs/AGENT-API.md): the image bytes as the body (any content type: the
// bytes are sniffed) → 201 { id, duplicate: false }, or 200 with the first thumbnail. 404 = not a print job of this
// device · 413 = over 4 MB · 415 = not a JPEG / PNG / WebP image.
export const POST = agentRoute(async (device, request, ctx: RouteContext<"/api/agent/print-jobs/[id]/thumbnail">) => {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 1024) {
    throw new AgentError("A thumbnail can be 4 MB at most.", undefined, 413);
  }
  const id = Number((await ctx.params).id);
  const name = new URL(request.url).searchParams.get("name") ?? "";
  const saved = await thumbnailFromAgent(device, id, name, new Uint8Array(await request.arrayBuffer()));
  if (!saved) return Response.json({ error: "No such print job from this device." }, { status: 404 });
  return Response.json(saved, { status: saved.duplicate ? 200 : 201 });
});
