import { NextRequest } from "next/server";
import { beforeAll, expect, test } from "vitest";
import { GET } from "@/app/api/files/[id]/route";
import { POST } from "@/app/api/files/route";
import { OWNER, signedIn, testOwner } from "@/db/test-owner";
import { MAX_UPLOAD_BYTES } from "@/lib/attachment-kinds";
import { checkUpload } from "@/lib/attachments";
import type { SessionUser } from "@/lib/permissions";
import { createUser } from "@/lib/users";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PDF = new TextEncoder().encode("%PDF-1.4\n% sample\n");
const text = (s: string) => new TextEncoder().encode(s);

let owner: SessionUser;
beforeAll(async () => {
  owner = await testOwner();
});

test("only photos and PDF, up to 4 MB, judged by the bytes not the name", () => {
  expect(checkUpload(JPEG)).toBe("image/jpeg");
  expect(checkUpload(PNG)).toBe("image/png");
  expect(checkUpload(PDF)).toBe("application/pdf");
  expect(() => checkUpload(text("just text"))).toThrow("Only photos");
  expect(() => checkUpload(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toThrow("Only photos");
  const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
  big.set(JPEG);
  expect(() => checkUpload(big)).toThrow("4 MB");
  expect(() => checkUpload(new Uint8Array())).toThrow("empty");
});

const url = "http://localhost:3000/api/files";
const context = (id: string) => ({ params: Promise.resolve({ id }) });
function upload(file: File, headers?: Headers, entityType = "settings") {
  const form = new FormData();
  form.set("file", file);
  form.set("entityType", entityType);
  form.set("entityId", "1");
  form.set("kind", "quotation");
  return POST(new NextRequest(url, { method: "POST", body: form, headers }));
}

test("the file routes answer 401 without a session", async () => {
  expect((await GET(new NextRequest(`${url}/1`), context("1"))).status).toBe(401);
  expect((await upload(new File([PDF], "a.pdf"))).status).toBe(401);
});

test("upload through the route, then view it; a text file named .png is refused", async () => {
  const cookie = await signedIn(OWNER.username, OWNER.password);
  const res = await upload(new File([PDF], "quote.pdf", { type: "application/pdf" }), cookie);
  expect(res.status).toBe(201);
  const { id } = await res.json();

  const file = await GET(new NextRequest(`${url}/${id}`, { headers: cookie }), context(String(id)));
  expect(file.status).toBe(200);
  expect(file.headers.get("content-type")).toBe("application/pdf");
  expect(file.headers.get("content-disposition")).toContain('filename="quote.pdf"');
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);

  const fake = await upload(new File([text("not an image")], "photo.png", { type: "image/png" }), cookie);
  expect(fake.status).toBe(400);
  expect((await fake.json()).error).toMatch(/Only photos/);
  expect((await upload(new File([PDF], "x.pdf"), cookie, "nowhere")).status).toBe(403);

  const crossSite = new Headers(cookie);
  crossSite.set("origin", "https://evil.example");
  expect((await upload(new File([PDF], "x.pdf"), crossSite)).status).toBe(403);
});

test("a role without access to the record can't upload to it or read its files", async () => {
  await createUser(owner, { name: "Acct", username: "acct.files", role: "accountant", canViewCost: true, password: "acct-pass-12" });
  const owners = await signedIn(OWNER.username, OWNER.password);
  const { id } = await (await upload(new File([JPEG], "logo.jpg"), owners)).json();

  const cookie = await signedIn("acct.files", "acct-pass-12");
  expect((await upload(new File([PDF], "a.pdf"), cookie)).status).toBe(403);
  expect((await GET(new NextRequest(`${url}/${id}`, { headers: cookie }), context(String(id)))).status).toBe(404);
});

test("anyone who can see a job may attach to it (D48): production uploads a photo, but not to a quotation", async () => {
  await createUser(owner, { name: "Prod", username: "prod.files", role: "production", canViewCost: false, password: "prod-pass-12" });
  const cookie = await signedIn("prod.files", "prod-pass-12");
  const res = await upload(new File([JPEG], "site.jpg"), cookie, "job");
  expect(res.status).toBe(201);
  const { id } = await res.json();
  expect((await GET(new NextRequest(`${url}/${id}`, { headers: cookie }), context(String(id)))).status).toBe(200);
  expect((await upload(new File([JPEG], "site.jpg"), cookie, "quotation")).status).toBe(403);
});
