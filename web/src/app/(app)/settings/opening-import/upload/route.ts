import { UserError } from "@/lib/action";
import { userFromHeaders } from "@/lib/auth";
import { importOpeningData, MAX_BYTES } from "@/lib/opening-import";
import { can } from "@/lib/permissions";

/**
 * POST multipart { file, mode: "check" | "import" } (T43): check = the validation preview (nothing saved); import =
 * the same in one transaction, kept only when nothing is wrong. The owner's (Settings).
 */
export async function POST(request: Request) {
  const user = await userFromHeaders(request.headers);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!can(user, "settings", "edit")) return Response.json({ error: "Not allowed" }, { status: 403 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES + 64 * 1024) {
    return Response.json({ error: "The file is over 2 MB: split it, or remove pictures and other sheets." }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Upload the file again." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Pick the Excel file." }, { status: 400 });
  try {
    const result = await importOpeningData(user, new Uint8Array(await file.arrayBuffer()), form.get("mode") === "import");
    return Response.json(result);
  } catch (e) {
    if (e instanceof UserError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
