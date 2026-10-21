import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDbForTests } from "./idb";
import { listRecoveryCopies, readRecoveryCopy, retainRecoveryCopy, type RecoveryCopy } from "./syncRecovery";
import {
  bookBytes, deleteBookRetainedCopies, deleteRetainedCopies, resetRetainedVersionCache, trashRetainedCopy, untrashRetainedCopy,
  versionBytes, versionsByBook,
} from "./retainedVersions";
import { readBookData, readSummaries } from "./retainedRead";
import { putContent } from "./contentStore";

const board = { v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
// A 2 MB PDF: the length rides in the hash's last segment, base 36.
const pdfHash = (bytes: number) => `binabc-${bytes.toString(36)}`;
const record = (id: string, bookId: string, updatedAt: number, source: string, hash = pdfHash(2_000_000)): RecoveryCopy => ({
  id, type: "record", kind: "annotate", bookId, provenance: { source },
  record: { meta: { kind: "annotate", id: bookId, name: "Book.pdf", label: "Exam", hash, docType: "pdf", updatedAt },
    payload: { source: "", board, footnotes: [], agent: [] } },
});

beforeEach(async () => {
  await closeDbForTests(); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  resetRetainedVersionCache();
});
afterEach(async () => { await closeDbForTests(); vi.unstubAllGlobals(); });

describe("retained copies as numbered versions", () => {
  it("numbers each book's restorable copies newest first, with a reason, and keeps bookkeeping rows aside", async () => {
    await retainRecoveryCopy(record("old", "book", 100, "document-source-update"));
    await retainRecoveryCopy(record("new", "book", 300, "atomic-book-hub-alternative"));
    await retainRecoveryCopy(record("other", "second", 200, "explicit-recovery-restore"));
    await retainRecoveryCopy({ id: "book-conflict:x", type: "conflict", kind: "annotate", bookId: "book",
      provenance: { source: "atomic-book-choice" }, content: { local: {}, remote: {} } });
    const { versions, attached } = await versionsByBook("annotate");
    expect(versions.get("book")!.map(row => [row.number, row.id, row.reason])).toEqual([
      [1, "new", "The hub's version, from a sync choice"],
      [2, "old", "Before updating to a newer file"],
    ]);
    expect(versions.get("second")!.map(row => row.number)).toEqual([1]);
    expect(attached.get("book")!.map(row => row.id)).toEqual(["book-conflict:x"]);
    expect((await versionsByBook("whiteboard")).versions.size).toBe(0);
  });

  it("numbers by when each copy was kept: a new one is 1 and the rest shift forward, none replaced", async () => {
    const kept = (id: string, at: number, edited: number): RecoveryCopy => ({ ...record(id, "book", edited, "document-source-update"),
      provenance: { source: "document-source-update", retainedAt: at } });
    await retainRecoveryCopy(kept("first", 1_000, 900));
    await retainRecoveryCopy(kept("second", 2_000, 1_900));
    expect((await versionsByBook("annotate")).versions.get("book")!.map(row => [row.number, row.id])).toEqual([[1, "second"], [2, "first"]]);
    // Kept last, though that version was last edited before the others.
    await retainRecoveryCopy(kept("third", 3_000, 500));
    expect((await versionsByBook("annotate")).versions.get("book")!.map(row => [row.number, row.id])).toEqual([[1, "third"], [2, "second"], [3, "first"]]);
    // Writing the same copy again with a later stamp is the same copy, not a fourth.
    await retainRecoveryCopy(kept("third", 9_000, 500));
    expect((await listRecoveryCopies()).length).toBe(3);
  });

  it("counts a copy's file only when it is not the file the book uses now", async () => {
    await retainRecoveryCopy(record("same", "book", 1, "snapshot-restore", pdfHash(2_000_000)));
    await retainRecoveryCopy(record("older-file", "book", 2, "document-source-update", pdfHash(1_500_000)));
    const rows = (await versionsByBook("annotate")).versions.get("book")!;
    const same = rows.find(row => row.id === "same")!, older = rows.find(row => row.id === "older-file")!;
    expect(versionBytes(same, pdfHash(2_000_000))).toBe(same.dataBytes);
    expect(versionBytes(older, pdfHash(2_000_000))).toBe(older.dataBytes + 1_500_000);
    expect(same.dataBytes).toBeGreaterThan(0);
  });

  it("trashes one copy on its own, takes it back out, and the trash mark is not part of its identity", async () => {
    await retainRecoveryCopy(record("a", "book", 1, "snapshot-restore"));
    await retainRecoveryCopy(record("b", "book", 2, "snapshot-restore"));
    await trashRetainedCopy("a");
    let rows = (await versionsByBook("annotate")).versions.get("book")!;
    expect(rows.find(row => row.id === "a")!.trashedAt).toBeGreaterThan(0);
    expect(rows.find(row => row.id === "b")!.trashedAt).toBeNull();
    // Retaining the same copy again (an idempotent writer) is not a changed identity.
    await expect(retainRecoveryCopy(record("a", "book", 1, "snapshot-restore"))).resolves.toBeUndefined();
    // A fresh read agrees with the cache.
    resetRetainedVersionCache();
    rows = (await versionsByBook("annotate")).versions.get("book")!;
    expect(rows.find(row => row.id === "a")!.trashedAt).toBeGreaterThan(0);
    await untrashRetainedCopy("a");
    expect((await readRecoveryCopy("a"))!.trashedAt).toBeUndefined();
  });

  it("deletes only the chosen copies for good, and a book deleted for good takes all of its own", async () => {
    await retainRecoveryCopy(record("a", "book", 1, "snapshot-restore"));
    await retainRecoveryCopy(record("b", "book", 2, "snapshot-restore"));
    await retainRecoveryCopy(record("keep", "second", 3, "snapshot-restore"));
    await retainRecoveryCopy({ id: "evidence", type: "conflict", kind: "annotate", bookId: "book", provenance: { source: "legacy-inline-original" }, content: {} });
    await deleteRetainedCopies(["a"]);
    expect((await listRecoveryCopies()).map(row => row.id).sort()).toEqual(["b", "evidence", "keep"]);
    await deleteBookRetainedCopies("annotate", "book");
    expect((await listRecoveryCopies()).map(row => row.id)).toEqual(["keep"]);
  });

  it("reads each copy once and only reads copies new since the last look", async () => {
    await retainRecoveryCopy(record("a", "book", 1, "snapshot-restore"));
    await versionsByBook("annotate");
    await retainRecoveryCopy(record("b", "book", 2, "snapshot-restore"));
    const rows = (await versionsByBook("annotate")).versions.get("book")!;
    expect(rows.map(row => row.id)).toEqual(["b", "a"]);
  });
});

describe("reading off the main thread", () => {
  /** A worker that answers in-process, as `retainedSizes.worker.ts` would. */
  function fakeWorker(fail = false) {
    const asks: string[] = [];
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage(request: { id: number; op: string; keys?: IDBValidKey[]; kind?: "annotate"; bookId?: string }) {
        asks.push(request.op);
        if (fail) { queueMicrotask(() => this.onerror?.({ message: "boom" } as ErrorEvent)); return; }
        const work = request.op === "summaries"
          ? readSummaries(request.keys!).then(summaries => ({ id: request.id, summaries }))
          : readBookData(request.kind!, request.bookId!).then(bytes => ({ id: request.id, bytes }));
        void work.then(reply => this.onmessage?.({ data: reply } as MessageEvent));
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", FakeWorker);
    return asks;
  }

  it("asks the worker for summaries and sizes, and agrees with reading them here", async () => {
    await retainRecoveryCopy(record("a", "book", 1, "snapshot-restore"));
    await putContent("book", { source: "x".repeat(500) });
    const here = { rows: (await versionsByBook("annotate")).versions.get("book")!, bytes: await bookBytes("annotate", "book", 1) };
    resetRetainedVersionCache();
    const asks = fakeWorker();
    const rows = (await versionsByBook("annotate")).versions.get("book")!;
    const bytes = await bookBytes("annotate", "book", 2);
    expect(asks).toEqual(["summaries", "book"]);
    expect(rows).toEqual(here.rows);
    expect(bytes).toBe(here.bytes);
  });

  it("reads here instead when the worker fails", async () => {
    await retainRecoveryCopy(record("a", "book", 1, "snapshot-restore"));
    const asks = fakeWorker(true);
    expect((await versionsByBook("annotate")).versions.get("book")!.map(row => row.id)).toEqual(["a"]);
    expect(asks).toEqual(["summaries"]);
  });
});
