import { userFromHeaders } from "@/lib/auth";
import { openingWorkbook } from "@/lib/opening-import";
import { can } from "@/lib/permissions";

/** The blank opening-data template (T43): the owner's (Settings). */
export async function GET(request: Request) {
  const user = await userFromHeaders(request.headers);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!can(user, "settings", "edit")) return Response.json({ error: "Not allowed" }, { status: 403 });
  return new Response(new Uint8Array(await openingWorkbook()), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="radhe-opening-data-template.xlsx"',
    },
  });
}
