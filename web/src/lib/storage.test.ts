import { expect, test } from "vitest";
import { storage } from "@/lib/storage";

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
