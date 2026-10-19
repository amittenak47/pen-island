import { IDBFactory, IDBKeyRange, IDBObjectStore, IDBDatabase } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureBook, publishBook } from "./bookSnapshot";
import { closeDbForTests, withStore, STORE_INK_PAGES } from "./idb";
import { inkPageKey, type InkPageRecord } from "./inkPageStore";
import { inkBookIdentity, resetBookCoordinatorForTests } from "./bookCoordinator";
import { resetLocalBookStoreForTests } from "./localBookStore";
import { encodeInkOps } from "../canvas/inkCodec";
import { recordHash } from "./syncContent";

beforeEach(async () => {
  await closeDbForTests(); resetLocalBookStoreForTests(); resetBookCoordinatorForTests();
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("localStorage", { length: 0, getItem: () => null, setItem: () => {}, key: () => null });
  vi.stubGlobal("navigator", { locks: { request: (_key: string, work: () => Promise<unknown>) => work() } });
});
afterEach(async () => { vi.restoreAllMocks(); await closeDbForTests(); resetLocalBookStoreForTests(); vi.unstubAllGlobals(); });

it.each(["annotate", "whiteboard", "problem"] as const)("writes explicit safe defaults on a first %s hub download", async kind => {
  const before = await captureBook({ kind, id: "new" });
  const note = { id: "note", kind: "note", excerpt: "x", createdAt: 1, anchor: { kind: "text", start: 0, end: 1 } };
  const record = { id: "new", updated_at: 1, board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } },
    agent: [{ id: "message", role: "user", content: "hello", at: 1 }],
    ...(kind === "annotate" ? { name: "Page", hash: "h", doc_type: "web", source: "page", footnotes: [note] }
      : kind === "whiteboard" ? { title: "Notebook", page_count: 1 } : { dataset: "d", task_id: "t" }),
  };
  const hash = await recordHash(record);
  const book = { kind, id: "new", state: "live" as const, book_rev: 1, record_rev: 1, record_hash: hash, record, pages: [], gone_seq: null };
  await publishBook(before, { book, record, recordLocalHash: hash, pages: [] });
  const after = await captureBook({ kind, id: "new" });
  expect(after.metadata).toHaveProperty("authoredExtras", {});
  if (kind === "annotate") {
    expect(after.metadata).toMatchObject({ owned: false, locked: false });
    expect(after.payload).toHaveProperty("captures", []);
    expect(after.payload!.footnotes).toMatchObject([{ title: "", anchor: { prefix: "", suffix: "" } }]);
  }
  if (kind === "whiteboard") expect(after.metadata).toMatchObject({ locked: false, named: false });
  expect(after.payload!.agent).toMatchObject([{ requestNote: "", reasoning: "", bridgeError: "" }]);
  expect(await recordHash(after.record)).toBe(hash);
});

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


it("captures the local HTML marker beside the original-file hash in a normal web record", async () => {
  const { saveAnnotateDoc } = await import("./annotateStore");
  await saveAnnotateDoc({ id: "local-html", name: "guide.html", docType: "web", hash: "original-hash", localFileHash: "original-hash",
    source: "<p>Rendered DOM</p>", board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } } });
  const capture = await captureBook({ kind: "annotate", id: "local-html" });
  expect(capture.record).toMatchObject({ doc_type: "web", hash: "original-hash", local_file_hash: "original-hash", source: "<p>Rendered DOM</p>" });
});

it("replaces the complete local page set when bringing acknowledged trash back from the hub", async () => {
  // Trash contains a local-only page; a later hub restore replaces active pages and retains the complete old local book.
  const { saveWhiteboardNotebook, trashWhiteboardNotebook } = await import("./whiteboardStore");
  const { putInkPages } = await import("./inkPageStore");
  const { listRecoveryCopies } = await import("./syncRecovery");
  await saveWhiteboardNotebook({ id: "book", title: "Local trash", pageCount: 1,
    board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } } });
  await putInkPages("wb:book", [[44, encodeInkOps([])]]); await trashWhiteboardNotebook("book");
  const before = await captureBook({ kind: "whiteboard", id: "book" });
  const record = { ...before.record!, title: "Restored hub book" };
  const book = { kind: "whiteboard" as const, id: "book", state: "live" as const, book_rev: 8,
    record_rev: 8, record_hash: "hub-record", record, pages: [], gone_seq: null };
  await publishBook(before, { book, record, recordLocalHash: "hub-record", pages: [], restoreFromHub: true,
    replacePages: true, alternative: { book, pages: [] } } as Parameters<typeof publishBook>[1]);
  const after = await captureBook({ kind: "whiteboard", id: "book" });
  expect(after.metadata?.deletedAt).toBeUndefined(); expect(after.pages).toEqual([]);
  expect((await listRecoveryCopies()).some(copy => copy.record?.ink?.some(page => page.pageId === 44))).toBe(true);
});

it.each([undefined, "", "   "])("writes an explicit empty wire label for %s", async label => {
  const { saveAnnotateDoc } = await import("./annotateStore");
  await saveAnnotateDoc({ id: "blank-label", name: "book.md", hash: "h", source: "", label,
    board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } } });
  expect((await captureBook({ kind: "annotate", id: "blank-label" })).record).toHaveProperty("label", "");
});
