import { IDBDatabase as FakeIDBDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashMarkdown } from "./annotateStore";
import { getLiveOriginal, liveOriginalKey, putLiveOriginal } from "./liveHtmlStore";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps frozen HTML keys identical to hashMarkdown", () => {
  expect(liveOriginalKey("<p>Still copy</p>")).toBe(hashMarkdown("<p>Still copy</p>"));
});

it("resolves harmlessly when IndexedDB is missing", async () => {
  vi.stubGlobal("indexedDB", undefined);
  await expect(getLiveOriginal("missing")).resolves.toBeNull();
  await expect(putLiveOriginal("missing", "original")).resolves.toBeUndefined();
});

it("resolves harmlessly when opening IndexedDB throws or fails", async () => {
  vi.spyOn(indexedDB, "open").mockImplementationOnce(() => { throw new Error("unavailable"); });
  await expect(putLiveOriginal("missing", "original")).resolves.toBeUndefined();
  vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
    const request = {} as IDBOpenDBRequest;
    queueMicrotask(() => request.onerror?.(new Event("error")));
    return request;
  });
  await expect(getLiveOriginal("missing")).resolves.toBeNull();
});

it("resolves harmlessly when a transaction fails", async () => {
  await putLiveOriginal("existing", "original");
  vi.spyOn(FakeIDBDatabase.prototype, "transaction").mockImplementation(() => { throw new Error("unavailable"); });
  await expect(getLiveOriginal("missing")).resolves.toBeNull();
  await expect(putLiveOriginal("missing", "original")).resolves.toBeUndefined();
});

it("stores and replaces originals in the separate version-one database", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1234);
  expect(await getLiveOriginal("missing")).toBeNull();
  await putLiveOriginal("frozen", "<script>first()</script>");
  expect(await getLiveOriginal("frozen")).toBe("<script>first()</script>");
  await putLiveOriginal("frozen", "<script>second()</script>");
  expect(await getLiveOriginal("frozen")).toBe("<script>second()</script>");
  const rows = await readRows();
  expect(rows).toEqual([{ original: "<script>second()</script>", savedAt: 1234 }]);
});

it("keeps the newest 200 by savedAt, including an updated old key", async () => {
  const now = vi.spyOn(Date, "now");
  for (let i = 0; i < 200; i += 1) {
    now.mockReturnValue(10000 + i);
    await putLiveOriginal(`key-${i}`, `original-${i}`);
  }
  now.mockReturnValue(20000);
  await putLiveOriginal("key-0", "updated");
  for (let i = 200; i < 205; i += 1) {
    now.mockReturnValue(10000 + i);
    await putLiveOriginal(`key-${i}`, `original-${i}`);
  }
  expect(await getLiveOriginal("key-0")).toBe("updated");
  for (let i = 1; i <= 5; i += 1) expect(await getLiveOriginal(`key-${i}`)).toBeNull();
  expect(await getLiveOriginal("key-6")).toBe("original-6");
  expect(await getLiveOriginal("key-204")).toBe("original-204");
  expect(await readRows()).toHaveLength(200);
});

function readRows(): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("whiteboard.liveHtml", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      expect(db.version).toBe(1);
      expect(Array.from(db.objectStoreNames)).toEqual(["originals"]);
      const store = db.transaction("originals").objectStore("originals");
      expect(store.keyPath).toBeNull();
      const rows = store.getAll();
      rows.onsuccess = () => { db.close(); resolve(rows.result); };
      rows.onerror = () => { db.close(); reject(rows.error); };
    };
  });
}
