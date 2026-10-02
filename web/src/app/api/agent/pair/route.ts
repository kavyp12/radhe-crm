import { AgentError, failure, pairDevice, readJson } from "@/lib/agent";

// POST /api/agent/pair (docs/AGENT-API.md): { code, name } → 201 { token, device }; the token is shown this once.
// The only agent call without a token. 401 = the code is wrong, used or older than 10 minutes.
export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AgentError("Send a JSON object.");
    const paired = await pairDevice(body as { code?: unknown; name?: unknown });
    if (!paired) {
      return Response.json({ error: "That pairing code is wrong, used or expired. Make a new one in Settings → Devices." }, { status: 401 });
    }
    return Response.json(paired, { status: 201 });
  } catch (e) {
    return failure(e);
  }
}
