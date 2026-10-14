import { IDBFactory, IDBKeyRange, IDBObjectStore, IDBDatabase } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureBook } from "./bookSnapshot";
import { closeDbForTests, withStore, STORE_INK_PAGES } from "./idb";
import { inkPageKey, type InkPageRecord } from "./inkPageStore";
import { inkBookIdentity, resetBookCoordinatorForTests } from "./bookCoordinator";
import { resetLocalBookStoreForTests } from "./localBookStore";
import { encodeInkOps } from "../canvas/inkCodec";

beforeEach(async () => {
  await closeDbForTests(); resetLocalBookStoreForTests(); resetBookCoordinatorForTests();
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("localStorage", { length: 0, getItem: () => null, setItem: () => {}, key: () => null });
  vi.stubGlobal("navigator", { locks: { request: (_key: string, work: () => Promise<unknown>) => work() } });
});
afterEach(async () => { vi.restoreAllMocks(); await closeDbForTests(); resetLocalBookStoreForTests(); vi.unstubAllGlobals(); });

it.each(["annotate", "whiteboard", "problem"] as const)("captures identical %s rows without reading unrelated ink, in one transaction", async kind => {
  const keys = ["md:book", "md:book-more", "wb:book", "wb:book-more", "fnwb:book:a", "fnwb:book:z", "fnwb:book-more:a", "fnwb:other:a", "md:other"];
  await withStore(STORE_INK_PAGES, "readwrite", store => {
    for (const docKey of keys) for (const pageId of [0, 2, 10]) {
      const row: InkPageRecord = { v: 1, docKey, pageId, inkC: encodeInkOps([]), dirty: true, updatedAt: 1 };
      store.put(row, inkPageKey(docKey, pageId));
    }
  });
  const all: InkPageRecord[] = [];
  await withStore(STORE_INK_PAGES, "readonly", store => { const read = store.getAll(); read.onsuccess = () => all.push(...read.result); });
  const expected = all.filter(row => { const owner = inkBookIdentity(row.docKey); return owner?.kind === kind && owner.id === "book"; });
  const transactions = vi.spyOn(IDBDatabase.prototype, "transaction"), getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
  const cursor = vi.spyOn(IDBObjectStore.prototype, "openCursor");
  const captured = await captureBook({ kind, id: "book" });
  expect(captured.pages).toEqual(expected);
  expect(transactions).toHaveBeenCalledOnce();
  const reads = [...getAll.mock.calls.map((args, i) => ({ store: getAll.mock.contexts[i]!, range: args[0] })),
    ...cursor.mock.calls.map((args, i) => ({ store: cursor.mock.contexts[i]!, range: args[0] }))].filter(read => (read.store as IDBObjectStore).name === STORE_INK_PAGES);
  expect(reads.length).toBe(kind === "problem" ? 0 : kind === "annotate" ? 2 : 1);
  for (const { range } of reads) {
    expect(range).toBeInstanceOf(IDBKeyRange);
    for (const row of all) if ((range as IDBKeyRange).includes(inkPageKey(row.docKey, row.pageId))) expect(expected).toContainEqual(row);
  }
});
