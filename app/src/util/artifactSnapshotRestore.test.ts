import { IDBFactory, IDBKeyRange as FakeKeyRange, IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeInkOps, packEncodedInk } from "../canvas/inkCodec";
import { bytesToB64 } from "../api/nativeHttp";
import { closeDbForTests, run, STORE_BOOK_META, STORE_CONTENT, STORE_INK_PAGES, STORE_SYNC_STATE } from "./idb";
import { mutateLocalBook, resetLocalBookStoreForTests } from "./localBookStore";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { getBookSyncState } from "./syncState";
import { getInkPageRecord, putInkPages } from "./inkPageStore";
import { resetContentRepairForTests } from "./contentStore";
import { restorePadSnapshotLocally } from "./artifactSnapshotRestore";
import type { PadSnapshot } from "./padSnapshotStore";
import { listRecoveryCopies } from "./syncRecovery";
import { timelineHarness, timelineOptions, drawing } from "./bookSyncTestHarness";
import { LcApiError } from "../api/client";

const board = { v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
const empty = encodeInkOps([]);
const page = (pageId: number, width = 700) => ({ pageId, updatedAt: 12,
  gz: bytesToB64(packEncodedInk({ ...empty, layout: { w: width, spread: false } })) });
const snapshot = (): PadSnapshot => ({ kind: "whiteboard", key: "book", tier: "2h", writtenAt: 12,
  name: "Old book", board, pageCount: 1, agent: ["old thread"], ink: [page(1)] });
beforeEach(async () => {
  await closeDbForTests(); resetLocalBookStoreForTests(); resetBookCoordinatorForTests(); resetContentRepairForTests();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", FakeKeyRange);
});
afterEach(async () => { await closeDbForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function seed(kind: "annotate" | "whiteboard" = "whiteboard") {
  await mutateLocalBook({ kind, id: "book" }, { requireIdb: true }, ctx => {
    ctx.setMetadata({ kind, id: "book", title: "Current book", name: "notes.md", hash: "source", docType: "markdown", updatedAt: 100, pageCount: 2, locked: true });
    ctx.setContent({ board, agent: ["current thread"], source: "# current", footnotes: [] });
  });
}

describe("transactional local snapshot restore", () => {
  it("replaces parent and ink together, empties later pages, and marks exactly one authored version", async () => {
    await seed(); await putInkPages("wb:book", [[1, empty], [2, empty]], { now: 100 });
    const before = (await getBookSyncState("whiteboard", "book"))!;
    await restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, snapshot());
    const meta = await run<Record<string, unknown>>(STORE_BOOK_META, "readonly", store => store.get("whiteboard:book"));
    const content = await run<Record<string, unknown>>(STORE_CONTENT, "readonly", store => store.get("book"));
    const state = (await getBookSyncState("whiteboard", "book"))!;
    expect(meta).toMatchObject({ title: "Old book", locked: true });
    expect(content).toMatchObject({ board, agent: ["old thread"] });
    const losing = await listRecoveryCopies("whiteboard", "book");
    expect(losing).toHaveLength(1);
    expect(losing[0]?.content).toMatchObject({ payload: { agent: ["current thread"] }, ink: [
      expect.objectContaining({ docKey: "wb:book", pageId: 1 }),
      expect.objectContaining({ docKey: "wb:book", pageId: 2 }),
    ] });
    expect(state.changeSeq).toBeGreaterThan(before.changeSeq);
    expect((await getInkPageRecord("wb:book", 1))?.changeSeq).toBe(state.changeSeq);
    expect(await getInkPageRecord("wb:book", 2)).toMatchObject({ inkC: empty, changeSeq: state.changeSeq, syncedChangeSeq: 0 });
  });

  it.each([undefined, null])("a backup with uncaptured ink (%s) replaces current ink with a tracked readable erasure", async ink => {
    await seed(); await putInkPages("wb:book", [[1, { ...empty, layout: { w: 500, spread: false } }]], { now: 100 });
    await restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, { ...snapshot(), ink });
    expect(await getInkPageRecord("wb:book", 1)).toMatchObject({ inkC: empty, dirty: true, bootstrap: true });
  });

  it.each([undefined, null])("older inline backup ink is recovered when shard ink is %s", async ink => {
    await seed(); await putInkPages("wb:book", [[1, empty]], { now: 100 });
    const inline = { ...empty, layout: { w: 500, spread: false } };
    await restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, { ...snapshot(), ink, board: { ...board, inkC: inline } });
    expect((await getInkPageRecord("wb:book", 1))?.inkC).toEqual(inline);
    expect(await run(STORE_CONTENT, "readonly", store => store.get("book"))).toMatchObject({ board: { inkC: inline } });
  });

  it.each([undefined, null])("preserves uncaptured source, root lists and attachments (%s)", async uncaptured => {
    await seed("annotate");
    const artifacts = { v: 1, parent: { kind: "annotate", id: "book" }, revision: "catalog", artifacts: [] };
    await mutateLocalBook({ kind: "annotate", id: "book" }, { requireIdb: true }, ctx => {
      ctx.setContent({ ...(ctx.content as Record<string, unknown>), artifacts, footnotes: [{ id: "kept" }] });
    });
    await restorePadSnapshotLocally({ kind: "annotate", id: "book" }, { ...snapshot(), kind: "annotate",
      source: uncaptured, agent: uncaptured, footnotes: uncaptured, artifactBundle: uncaptured });
    expect(await run(STORE_CONTENT, "readonly", store => store.get("book"))).toMatchObject({
      source: "# current", agent: ["current thread"], footnotes: [{ id: "kept" }], artifacts,
    });
  });

  it.each([undefined, null, []])("distinguishes uncaptured child ink from captured empty ink (%s)", async ink => {
    await seed("annotate"); await putInkPages("fnwb:book:child", [[1, empty]], { now: 100 });
    const inline = { ...empty, layout: { w: 500, spread: false } };
    await restorePadSnapshotLocally({ kind: "annotate", id: "book" }, { ...snapshot(), kind: "annotate", agent: [], footnotes: [], source: "",
      footnoteBoards: { child: { board: { ...board, inkC: inline }, pageCount: 1 } }, footnoteInk: ink === undefined ? {} : { child: ink } });
    expect((await getInkPageRecord("fnwb:book:child", 1))?.inkC).toEqual(ink == null ? inline : empty);
    expect(await run(STORE_CONTENT, "readonly", store => store.get("book"))).toMatchObject({ source: "", agent: [], footnotes: [] });
  });

  it("captured empty primary ink disables legacy inline recovery", async () => {
    await seed(); await putInkPages("wb:book", [[1, empty]], { now: 100 });
    await restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, { ...snapshot(), ink: [],
      board: { ...board, inkC: { ...empty, layout: { w: 500, spread: false } } } });
    expect((await getInkPageRecord("wb:book", 1))?.inkC).toEqual(empty);
  });

  it("restores all scratch content and ink atomically, including a backup without source", async () => {
    await seed("annotate"); await putInkPages("fnwb:book:old", [[1, empty]], { now: 100 });
    await run(STORE_CONTENT, "readwrite", store => store.put({ board, pageCount: 1 }, "fnwb:book:old"));
    await restorePadSnapshotLocally({ kind: "annotate", id: "book" }, { ...snapshot(), kind: "annotate", ink: [],
      footnoteBoards: { restored: { board, pageCount: 1 } }, footnoteInk: { restored: [page(1)] } });
    expect(await run(STORE_CONTENT, "readonly", store => store.get("fnwb:book:old"))).toBeUndefined();
    expect(await run(STORE_CONTENT, "readonly", store => store.get("fnwb:book:restored"))).toEqual({ board, pageCount: 1 });
    expect((await getInkPageRecord("fnwb:book:old", 1))?.inkC).toEqual(empty);
    const state = (await getBookSyncState("annotate", "book"))!;
    expect((await getInkPageRecord("fnwb:book:restored", 1))?.changeSeq).toBe(state.changeSeq);
    expect(await run(STORE_CONTENT, "readonly", store => store.get("book"))).toMatchObject({ source: "# current" });
  });

  it("restores a retained whiteboard backup after its live parent has been removed", async () => {
    await restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, snapshot());
    expect(await run(STORE_BOOK_META, "readonly", store => store.get("whiteboard:book"))).toMatchObject({ title: "Old book" });
    expect(await getInkPageRecord("wb:book", 1)).toMatchObject({ bootstrap: true, syncedRev: 0, syncedChangeSeq: 0 });
  });

  it("invalid snapshot bytes never clear readable current data", async () => {
    await seed(); await putInkPages("wb:book", [[1, empty]], { now: 100 });
    const current = await getInkPageRecord("wb:book", 1), state = await getBookSyncState("whiteboard", "book");
    await expect(restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, { ...snapshot(), ink: [{ pageId: 1, updatedAt: 1, gz: "YQ==" }] })).rejects.toThrow();
    expect(await getInkPageRecord("wb:book", 1)).toEqual(current);
    expect(await getBookSyncState("whiteboard", "book")).toEqual(state);
  });

  it("unreadable current ink is preserved instead of manufacturing an empty replacement", async () => {
    await seed();
    await run(STORE_INK_PAGES, "readwrite", store => store.put({ v: 1, docKey: "wb:book", pageId: 1, gz: new Uint8Array([1]), dirty: false, updatedAt: 1 }, "wb:book\u001f1"));
    const unreadable = await getInkPageRecord("wb:book", 1);
    await expect(restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, snapshot())).rejects.toThrow("unreadable");
    expect(await getInkPageRecord("wb:book", 1)).toEqual(unreadable);
  });

  it("a late transaction abort rolls parent, child, ink and tracking back together", async () => {
    await seed(); await putInkPages("wb:book", [[1, empty]], { now: 100 });
    const before = await run(STORE_CONTENT, "readonly", store => store.get("book"));
    const metadata = await run(STORE_BOOK_META, "readonly", store => store.get("whiteboard:book"));
    const ink = await getInkPageRecord("wb:book", 1), state = await getBookSyncState("whiteboard", "book");
    const counter = await run(STORE_SYNC_STATE, "readonly", store => store.get("__seq"));
    const put = FakeObjectStore.prototype.put;
    vi.spyOn(FakeObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      if (this.name === STORE_INK_PAGES) request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, snapshot())).rejects.toThrow();
    expect(await run(STORE_CONTENT, "readonly", store => store.get("book"))).toEqual(before);
    expect(await run(STORE_BOOK_META, "readonly", store => store.get("whiteboard:book"))).toEqual(metadata);
    expect(await getInkPageRecord("wb:book", 1)).toEqual(ink);
    expect(await getBookSyncState("whiteboard", "book")).toEqual(state);
    expect(await run(STORE_SYNC_STATE, "readonly", store => store.get("__seq"))).toEqual(counter);
  });
});


it("restoring frozen HTML preserves the local file's original hash and marker", async () => {
  await seed("annotate");
  await mutateLocalBook({ kind: "annotate", id: "book" }, { requireIdb: true }, ctx => {
    ctx.setMetadata({ ...ctx.metadata!, docType: "web", name: "guide.html", hash: "original-hash", localFileHash: "original-hash" });
  });
  await restorePadSnapshotLocally({ kind: "annotate", id: "book" }, { ...snapshot(), kind: "annotate", source: "<p>Varying rendered HTML</p>" });
  expect(await run(STORE_BOOK_META, "readonly", store => store.get("annotate:book"))).toMatchObject({
    docType: "web", hash: "original-hash", localFileHash: "original-hash",
  });
  expect(await run(STORE_CONTENT, "readonly", store => store.get("book"))).toMatchObject({ source: "<p>Varying rendered HTML</p>" });
});

it.each([true, false])("restores a hub snapshot's captured source identity over the current PDF metadata (optional fields: %s)", async optional => {
  // A shared full-version snapshot predates a source replacement -> restoring it restores its source identity too.
  const h = await timelineHarness("annotate"); h.status("offline"); await seed("annotate");
  await mutateLocalBook({ kind: "annotate", id: "book" }, { requireIdb: true }, ctx => {
    ctx.setMetadata({ ...ctx.metadata!, docType: "pdf", hash: "current-source", localFileHash: "current-source", label: "Current label" });
  });
  const saved = { ...snapshot(), kind: "annotate" as const, source: "", bookRecord: { id: "book", name: "Saved.pdf",
    doc_type: "pdf", hash: "saved-source", board, future: { author: "saved" },
    ...(optional ? { local_file_hash: "saved-source", label: "Saved label" } : {}) } };
  expect(await restorePadSnapshotLocally({ kind: "annotate", id: "book" }, saved)).toEqual({ status: "queued" });
  const restored = (await h.capture()).record!;
  expect(restored.hash).toBe("saved-source"); expect(restored.doc_type).toBe("pdf");
  expect(restored.local_file_hash).toBe(optional ? "saved-source" : undefined);
  expect(restored.label).toBe(optional ? "Saved label" : ""); expect(restored.future).toEqual({ author: "saved" });
});

describe("snapshot restore hub checks", () => {
  it("returns queued offline and leaves the restore authored for the next sync", async () => {
    // Synced book -> offline snapshot restore -> durable new local edit without a request.
    const h = await timelineHarness(); await h.initial(); h.status("offline"); h.clearCalls();
    expect(await restorePadSnapshotLocally({ kind: h.kind, id: h.id }, snapshot(), undefined, { client: h.api, ...timelineOptions })).toEqual({ status: "queued" });
    expect((await h.capture()).record?.title).toBe("Old book");
    expect((await h.capture()).state.changeSeq).toBeGreaterThan((await h.capture()).state.syncedChangeSeq);
    expect(h.api.getBookState).not.toHaveBeenCalled(); expect(h.api.commitPad).not.toHaveBeenCalled();
  });

  it("pushes immediately and preserves the replaced hub head as a shared snapshot copy", async () => {
    // Synced book -> online snapshot restore -> new hub head and immutable previous hub version.
    const h = await timelineHarness(); await h.initial(); const previous = structuredClone(h.get()); h.clearCalls();
    expect(await restorePadSnapshotLocally({ kind: h.kind, id: h.id }, snapshot(), undefined, { client: h.api, ...timelineOptions })).toEqual({ status: "restored" });
    expect(h.get().record?.title).toBe("Old book"); expect(h.api.commitPad).toHaveBeenCalledOnce();
    expect(h.api.putSnapshotCopy).toHaveBeenCalled();
    const saved = vi.mocked(h.api.putSnapshotCopy).mock.calls.at(-1)!;
    expect(saved[3].payload).toMatchObject({ name: previous.record?.title, ink: expect.arrayContaining([expect.objectContaining({ pageId: 1 }), expect.objectContaining({ pageId: 2 })]) });
  });

  it.each(["record", "page"] as const)("refuses an unseen %s change without changing local data", async change => {
    // Synced book -> another device changes one component -> stale restore leaves all stores untouched.
    const h = await timelineHarness(); await h.initial();
    if (change === "record") await h.otherRecord("Unseen edit"); else await h.otherPage(1, drawing());
    const before = await h.capture(), retained = await listRecoveryCopies(); h.clearCalls();
    expect(await restorePadSnapshotLocally({ kind: h.kind, id: h.id }, snapshot(), undefined, { client: h.api, ...timelineOptions })).toEqual({ status: "stale" });
    expect(await h.capture()).toEqual(before); expect(await listRecoveryCopies()).toEqual(retained);
    expect(h.api.commitPad).not.toHaveBeenCalled(); expect(h.api.putSnapshotCopy).not.toHaveBeenCalled();
  });

  it("accepts a newer revision with unchanged record and page content", async () => {
    // Synced book -> hub revision advances without content changes -> restore still commits immediately.
    const h = await timelineHarness(); await h.initial(); h.get().book_rev += 100;
    expect(await restorePadSnapshotLocally({ kind: h.kind, id: h.id }, snapshot(), undefined, { client: h.api, ...timelineOptions })).toEqual({ status: "restored" });
    expect(h.get().record?.title).toBe("Old book");
  });

  it("keeps the local book unchanged if preserving the hub snapshot fails", async () => {
    // Unseen hub edit -> force restore -> failed shared backup prevents local replacement.
    const h = await timelineHarness(); await h.initial(); await h.otherRecord("Unseen edit"); const before = await h.capture();
    vi.mocked(h.api.putSnapshotCopy).mockRejectedValueOnce(new Error("snapshot backup failed"));
    await expect(restorePadSnapshotLocally({ kind: h.kind, id: h.id }, snapshot(), undefined, { client: h.api, force: true, ...timelineOptions })).rejects.toThrow("snapshot backup failed");
    expect(await h.capture()).toEqual(before); expect(h.get().record?.title).toBe("Unseen edit");
  });

  it("does not treat an authorization failure as an offline restore", async () => {
    // Online restore -> hub refuses its preflight -> current local book stays intact.
    const h = await timelineHarness(); await h.initial(); const before = await h.capture();
    vi.mocked(h.api.getBookState).mockRejectedValueOnce(new LcApiError("Unauthorized", 401));
    await expect(restorePadSnapshotLocally({ kind: h.kind, id: h.id }, snapshot(), undefined, { client: h.api, ...timelineOptions })).rejects.toThrow("Unauthorized");
    expect(await h.capture()).toEqual(before);
  });
});
