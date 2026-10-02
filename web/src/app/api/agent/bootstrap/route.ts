import { agentRoute, bootstrap } from "@/lib/agent";

// GET /api/agent/bootstrap (docs/AGENT-API.md): what the popup picks from, cached by the agent for offline use.
export const GET = agentRoute(async (device) => Response.json(await bootstrap(device)));
