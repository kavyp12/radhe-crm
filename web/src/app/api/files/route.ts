import type { NextRequest } from "next/server";
import { UserError } from "@/lib/action";
import { MAX_UPLOAD_BYTES } from "@/lib/attachment-kinds";
import { canAttach, saveAttachment } from "@/lib/attachments";
import { userFromHeaders } from "@/lib/auth";

// Upload: multipart form with file, entityType, entityId, kind. A route handler, not a server action (1 MB cap).
export async function POST(request: NextRequest) {
  const user = await userFromHeaders(request.headers);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  // Same-site only (the session cookie is SameSite=Lax too): another site can't post files as this user.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== request.nextUrl.host) {
    return Response.json({ error: "Not allowed" }, { status: 403 });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64 * 1024) {
    return Response.json({ error: "Files can be 4 MB at most." }, { status: 413 });
  }
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File)) return Response.json({ error: "Choose a file." }, { status: 400 });
  const entityType = String(form.get("entityType") ?? "");
  if (!canAttach(user, entityType, "edit")) return Response.json({ error: "Not allowed" }, { status: 403 });

  try {
    const row = await saveAttachment(user, {
      entityType,
      entityId: Number(form.get("entityId")),
      kind: String(form.get("kind") ?? "other"),
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return Response.json({ id: row.id }, { status: 201 });
  } catch (e) {
    if (e instanceof UserError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
