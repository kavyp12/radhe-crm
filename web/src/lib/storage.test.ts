import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { storage, supabaseStorage } from "@/lib/storage";

test("put then get returns the same bytes; a missing key is null", async () => {
  const key = `test/${crypto.randomUUID()}.bin`;
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  await storage.put(key, bytes);
  expect(await storage.get(key)).toEqual(bytes);
  expect(await storage.get(`test/${crypto.randomUUID()}.bin`)).toBeNull();
  await expect(storage.put(key, new Uint8Array([9]))).rejects.toThrow(); // never overwrites
});

test("keys can't leave the storage folder", async () => {
  await expect(storage.put("../escape.txt", new Uint8Array([1]))).rejects.toThrow("Bad storage key");
  await expect(storage.get("test/../../secret.txt")).rejects.toThrow("Bad storage key");
  await expect(storage.get("C:/windows/win.ini")).rejects.toThrow("Bad storage key");
});

// T44a (D34, D69): the Supabase driver against a small fake of the Storage REST API — the real one answers errors
// as JSON { statusCode, error, message }, older servers with HTTP 400 and the real code inside.
const SECRET = "sb_secret_test-key";
const LEGACY = "eyJhbGciOiJIUzI1NiJ9.service-role.sig";
const objects = new Map<string, Buffer>();
const seen: { method: string; url: string; apikey?: string; authorization?: string; upsert?: string }[] = [];
const server = createServer(async (req: IncomingMessage, res) => {
  seen.push({ method: req.method!, url: req.url!, apikey: req.headers.apikey as string, authorization: req.headers.authorization, upsert: req.headers["x-upsert"] as string });
  const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (req.headers.apikey !== SECRET && req.headers.apikey !== LEGACY) return send(400, { statusCode: "403", error: "Unauthorized", message: "Invalid key" });
  const upload = req.url!.match(/^\/storage\/v1\/object\/files\/(.+)$/);
  const download = req.url!.match(/^\/storage\/v1\/object\/authenticated\/([^/]+)\/(.+)$/);
  if (req.method === "POST" && upload) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (objects.has(upload[1]) && req.headers["x-upsert"] !== "true") return send(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
    objects.set(upload[1], Buffer.concat(chunks));
    return send(200, { Key: `files/${upload[1]}` });
  }
  if (req.method === "GET" && download) {
    if (download[1] !== "files") return send(404, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
    const body = objects.get(download[2]);
    if (!body) return send(400, { statusCode: "404", error: "not_found", message: "Object not found" });
    return res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
  }
  send(500, { statusCode: "500", error: "internal", message: "boom" });
});
let url = "";
beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`; // a trailing slash is fine
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

test("Supabase driver: upload then download through the REST API, never overwriting; a missing object is null", async () => {
  const s = supabaseStorage({ url, key: SECRET, bucket: "files" });
  const key = "attachments/2026/10/photo-1.jpg";
  const bytes = new Uint8Array([0xff, 0xd8, 0, 1, 2, 0xff, 0xd9]);
  await s.put(key, bytes);
  expect(await s.get(key)).toEqual(bytes);
  expect(seen.at(-2)).toEqual({ method: "POST", url: `/storage/v1/object/files/${key}`, apikey: SECRET, authorization: undefined, upsert: "false" });
  expect(seen.at(-1)).toMatchObject({ method: "GET", url: `/storage/v1/object/authenticated/files/${key}`, apikey: SECRET, authorization: undefined });
  await expect(s.put(key, new Uint8Array([1]))).rejects.toThrow("Duplicate");
  expect(await s.get(key)).toEqual(bytes);
  expect(await s.get("attachments/2026/10/none.jpg")).toBeNull();
  // The keys are checked before any request, as on disk.
  await expect(s.get("../etc/passwd.txt")).rejects.toThrow("Bad storage key");
});

test("Supabase driver: a legacy service_role key also goes as the Bearer token; setup errors are errors, not missing files", async () => {
  const legacy = supabaseStorage({ url, key: LEGACY, bucket: "files" });
  await legacy.put("attachments/legacy.png", new Uint8Array([1, 2]));
  expect(seen.at(-1)).toMatchObject({ apikey: LEGACY, authorization: `Bearer ${LEGACY}` });
  await expect(supabaseStorage({ url, key: "wrong", bucket: "files" }).get("attachments/legacy.png")).rejects.toThrow("Unauthorized");
  await expect(supabaseStorage({ url, key: SECRET, bucket: "nope" }).get("attachments/legacy.png")).rejects.toThrow("Bucket not found");
});
