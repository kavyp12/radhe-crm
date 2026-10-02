import { agentRoute, reprintCheck } from "@/lib/agent";

// GET /api/agent/reprint-check?path=<full path>&name=<file name> (docs/AGENT-API.md): the latest print jobs of that
// file, for the popup's "New or Reprint?" question (P8).
export const GET = agentRoute(async (_device, request) => {
  const q = new URL(request.url).searchParams;
  return Response.json(await reprintCheck(q.get("path"), q.get("name")));
});
