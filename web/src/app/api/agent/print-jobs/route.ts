import { agentRoute, createFromAgent, readJson } from "@/lib/agent";

// POST /api/agent/print-jobs (docs/AGENT-API.md): one print from the popup → 201 { id, number, customer_id,
// duplicate: false }, or 200 with the first one (duplicate: true) when its client_uuid was sent before.
export const POST = agentRoute(async (device, request) => {
  const saved = await createFromAgent(device, await readJson(request));
  return Response.json(saved, { status: saved.duplicate ? 200 : 201 });
});
