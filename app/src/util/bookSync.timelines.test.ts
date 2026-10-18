import { afterEach, describe, expect, it, vi } from "vitest";
import { type BookConflict, type BookSyncOptions, syncBook } from "./bookSync";
import type { ConflictUiLifecycle } from "./conflictUiWait";
import { captureBook } from "./bookSnapshot";
import { encodedFromRecord, putInkPages } from "./inkPageStore";
import { deletePadEverywhere, restoreTrashedPad } from "./padSync";
import { restorePadSnapshotLocally } from "./artifactSnapshotRestore";
import { restoreRetainedRecord } from "./recoveryRestore";
import { listRecoveryCopies, retainRecoveryCopy } from "./syncRecovery";
import type { PadSnapshot } from "./padSnapshotStore";
import { bytesToB64, b64ToBytes } from "../api/nativeHttp";
import { decodeInkOps, encodeInkOps, packEncodedInk, unpackEncodedInk } from "../canvas/inkCodec";
import { conflictPdfFrames } from "../components/conflictDocumentLayout";
import { savePdfPageSizes } from "../modes/pdfPageSizeCache";
import { pdfInkContextFromRecord } from "./pdfInkLayout";
import { sweepAnnotateTrash } from "./annotateStore";
import { sweepWhiteboardTrash } from "./whiteboardStore";
import { bookFailureMessage } from "./bookSyncMessages";
import { findAnnotateDocByHash, getAnnotateDoc, saveAnnotateDoc } from "./annotateStore";
import { getDocBytes, hashBytes, putDocBytes } from "./docBytes";
import { recordHash, validateInk } from "./syncContent";
import { board, closeTimelineHarness, drawing, emptyInk, timelineHarness, timelineKinds, timelineOptions } from "./bookSyncTestHarness";

afterEach(closeTimelineHarness);

type TimelineHarness = Awaited<ReturnType<typeof timelineHarness>>;
const titleOf = (h: TimelineHarness, record: Record<string, unknown> | null) => record?.[h.kind === "whiteboard" ? "title" : "name"];
async function snapshotOf(h: TimelineHarness, name = "Snapshot", color = "#006600"): Promise<Partial<PadSnapshot>> {
  return { kind: h.kind, key: h.id, tier: "2h", writtenAt: 1, name, board, source: "snapshot source", footnotes: [], agent: [], pageCount: 2,
    ink: [1, 2].map(pageId => ({ pageId, updatedAt: 1, gz: bytesToB64(packEncodedInk(pageId === 1 ? drawing(color) : emptyInk)) })) };
}
async function snapshotFromCapture(h: TimelineHarness): Promise<Partial<PadSnapshot>> {
  const capture = await h.capture();
  return { ...await snapshotOf(h), name: String(titleOf(h, capture.record)), board: capture.payload!.board as typeof board,
    source: capture.payload?.source as string, ink: await Promise.all(capture.pages.filter(page => page.docKey === h.localKey).map(async page => ({
      pageId: page.pageId, updatedAt: page.updatedAt, gz: bytesToB64(packEncodedInk((await encodedFromRecord(page))!)),
    }))) };
}
const restoreSnapshot = (h: TimelineHarness, snapshot: Partial<PadSnapshot>, force = false) =>
  restorePadSnapshotLocally({ kind: h.kind, id: h.id }, snapshot, undefined, { client: h.api, ...timelineOptions, force });
async function otherDevice(h: TimelineHarness) {
  await h.switchDevice("other"); expect((await h.sync({ allowCreate: true })).status).toBe("synced");
}
async function expectHubCopy(h: TimelineHarness, name: string, ink = drawing()) {
  const copies = await h.api.listSnapshotCopies(h.kind, h.id);
  const bodies = await Promise.all(copies.map(copy => h.api.getSnapshotCopy(h.kind, h.id, copy.content_hash)));
  const payloads = bodies.map(body => body?.payload as Partial<PadSnapshot> | undefined);
  const copy = payloads.find(payload => payload?.name === name);
  expect(copy, `hub snapshot copy of ${name}`).toBeDefined();
  const page = copy!.ink?.find(row => row.pageId === 1);
  expect(page).toBeDefined();
  expect(decodeInkOps(unpackEncodedInk((await validateInk(b64ToBytes(page!.gz))).packed)!)).toEqual(decodeInkOps(ink));
}

async function deletedElsewhereConflict(otherFirst: boolean) {
  for (const kind of timelineKinds) for (const edits of ["record", "ink", "both"] as const) for (const choice of ["automatic", "local", "server"] as const) {
    const h = await timelineHarness(kind); await h.initial();
    if (otherFirst) h.otherDelete();
    if (edits !== "ink") await h.save("My edited book");
    if (edits !== "record") await putInkPages(h.localKey, [[1, drawing()], [44, drawing("#aa0000")]]);
    if (!otherFirst) h.otherDelete();
    const before = await h.capture(), head = h.get().book_rev; h.clearCalls();
    const requestChoice = vi.fn(async (conflict: BookConflict, lifecycle: ConflictUiLifecycle) => {
      lifecycle.onMounted(); expect(conflict.lifecycle).toBe(true); expect(conflict.remote.state).toBe("gone");
      return { lifecycle: choice === "local" ? "local" as const : "server" as const,
        record: "local" as const, pages: conflict.pages.map(page => ({ key: page.key, pageId: page.page_id, choice: "local" as const })) };
    });
    const result = await h.sync({ manual: choice !== "automatic", requestChoice });
    if (choice === "automatic") {
      expect(result.status).toBe("needs_choice"); expect(result.error?.kind).toBe("needs_choice");
      expect(bookFailureMessage(result)).toBe(`${edits === "ink" ? "Book" : "My edited book"} was deleted on another device. Open it to keep your copy or delete it.`);
      expect(requestChoice).not.toHaveBeenCalled(); expect(await h.capture()).toEqual(before); expect(h.api.commitPad).not.toHaveBeenCalled();
    } else if (choice === "local") {
      expect(result.status).toBe("synced"); expect(requestChoice).toHaveBeenCalledOnce(); expect(h.get().state).toBe("live");
      expect(await recordHash(h.get().record!)).toBe(await recordHash(before.record!));
      const body = vi.mocked(h.api.commitPad).mock.calls[0]![0];
      expect(body).toMatchObject({ action: "restore", base_book_rev: head }); expect(body.record).not.toBeNull();
      expect(body.pages.map(page => page.page_id).sort((a, b) => a - b)).toEqual(before.pages.map(page => page.pageId).sort((a, b) => a - b));
      expect((await h.hubInk(1))?.ops).toEqual((edits === "record" ? emptyInk : drawing()).ops);
      expect((await h.hubInk(2))?.ops).toEqual(emptyInk.ops);
      if (edits !== "record") expect((await h.hubInk(44))?.ops).toEqual(drawing("#aa0000").ops);
      const after = await h.capture(); expect(after.metadata?.deletedAt).toBeUndefined(); expect(after.state.lifecycle).toBeNull();
      expect((await h.sync()).status).toBe("unchanged");
    } else {
      expect(result.status).toBe("synced"); expect(requestChoice).toHaveBeenCalledOnce(); expect(h.get().state).toBe("gone"); expect(h.api.commitPad).not.toHaveBeenCalled();
      const after = await h.capture(); expect(after.metadata).toMatchObject({ deletedAt: expect.any(Number), deleteAcked: true, deleteFollowed: false });
      expect(after.state.lifecycle).toBeNull(); expect(after.payload).toEqual(before.payload); expect(after.pages).toEqual(before.pages);
      expect((await h.sync()).status).toBe("unchanged");
    }
  }
}

describe("book delete timelines", () => {
  it("T1 synced here, deleted elsewhere, then sync follows the delete once", async () => {
    // This syncs → the other device deletes → this syncs twice.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); const before = await h.capture(); h.otherDelete(); h.clearCalls();
      const result = await h.sync(); expect(result).toMatchObject({ status: "synced", notice: "deleted_elsewhere", committed: false });
      const after = await h.capture(); expect(after.metadata).toMatchObject({ deletedAt: expect.any(Number), deleteAcked: true, deleteFollowed: true });
      expect(after.state.lifecycle).toBeNull(); expect(after.payload).toEqual(before.payload); expect(after.pages).toEqual(before.pages);
      expect((await h.sync()).status).toBe("unchanged"); expect(h.api.commitPad).not.toHaveBeenCalled();
    }
  });

  it("T2 edits made before the other device deletes require an explicit lifecycle choice", async () => {
    // This edits without syncing → the other device deletes → automatic sync or Keep mine / Delete.
    await deletedElsewhereConflict(false);
  });

  it("T3 edits made after the other device deletes require the same explicit choice", async () => {
    // The other device deletes → this edits without syncing → automatic sync or Keep mine / Delete.
    await deletedElsewhereConflict(true);
  });

  it("T4 an online stale delete checks changed hub ink before trashing and force uses the current head", async () => {
    // The other device changes ink and syncs → this deletes online → this chooses Delete anyway.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); await h.otherPage(1, drawing()); await h.otherPage(44, drawing("#aa0000"));
      const before = await h.capture(), head = h.get().book_rev; h.clearCalls();
      expect(await deletePadEverywhere(h.api, kind, h.id, undefined, timelineOptions)).toEqual({ status: "stale" });
      expect(await h.capture()).toEqual(before); expect(h.api.commitPad).not.toHaveBeenCalled(); expect(h.api.getBookState).toHaveBeenCalled();
      expect(await deletePadEverywhere(h.api, kind, h.id, undefined, { ...timelineOptions, force: true } as BookSyncOptions & { force: true })).toEqual({ status: "deleted" });
      expect(h.get().state).toBe("gone"); expect(vi.mocked(h.api.commitPad).mock.calls[0]![0]).toMatchObject({ action: "delete", base_book_rev: head });
      const after = await h.capture(); expect(after.metadata).toMatchObject({ deletedAt: expect.any(Number), deleteAcked: true }); expect(after.state.lifecycle).toBeNull();
      expect(after.payload).toEqual(before.payload); expect(after.pages).toEqual(before.pages);
    }
  });

  it("T5 a remote rename alone makes an online delete stale until forced", async () => {
    // The other device renames and syncs → this deletes online → this chooses Delete anyway.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); await h.otherRecord("Renamed elsewhere");
      const before = await h.capture(), head = h.get().book_rev; h.clearCalls();
      expect(await deletePadEverywhere(h.api, kind, h.id, undefined, timelineOptions)).toEqual({ status: "stale" });
      expect(await h.capture()).toEqual(before); expect(h.api.commitPad).not.toHaveBeenCalled();
      expect(await deletePadEverywhere(h.api, kind, h.id, undefined, { ...timelineOptions, force: true } as BookSyncOptions & { force: true })).toEqual({ status: "deleted" });
      expect(h.get().state).toBe("gone"); expect(vi.mocked(h.api.commitPad).mock.calls[0]![0]).toMatchObject({ action: "delete", base_book_rev: head });
      const after = await h.capture(); expect(after.metadata).toMatchObject({ deletedAt: expect.any(Number), deleteAcked: true }); expect(after.state.lifecycle).toBeNull();
      expect(after.payload).toEqual(before.payload); expect(after.pages).toEqual(before.pages);
    }
  });

  it("T6 online deletes on both devices settle quietly in either order", async () => {
    // The other device deletes → this deletes, or this deletes → the other device deletes → this syncs.
    for (const kind of timelineKinds) for (const otherFirst of [true, false]) {
      const h = await timelineHarness(kind); await h.initial(); const before = await h.capture(); h.clearCalls();
      const requestChoice = vi.fn();
      if (otherFirst) h.otherDelete();
      await h.trash();
      if (!otherFirst) { expect((await h.sync({ manual: true, requestChoice })).status).toBe("synced"); h.otherDelete(); }
      const result = await h.sync({ manual: true, requestChoice }); expect(result.error).toBeUndefined(); expect(result.status).toMatch(/^(synced|unchanged)$/);
      expect(requestChoice).not.toHaveBeenCalled(); if (otherFirst) expect(h.api.commitPad).not.toHaveBeenCalled();
      const after = await h.capture(); expect(after.metadata).toMatchObject({ deletedAt: expect.any(Number), deleteAcked: true }); expect(after.state.lifecycle).toBeNull();
      expect(after.payload).toEqual(before.payload); expect(after.pages).toEqual(before.pages); expect((await h.sync()).status).toBe("unchanged");
    }
  });

  it("T7 queued offline deletes on both devices settle in either reconnect order", async () => {
    // Both devices delete offline → either one reconnects first → this reconnects and syncs.
    for (const kind of timelineKinds) for (const otherFirst of [true, false]) {
      const h = await timelineHarness(kind); await h.initial(); const before = await h.capture(); h.clearCalls(); h.status("offline");
      await deletePadEverywhere(h.api, kind, h.id, undefined, timelineOptions);
      expect((await h.capture()).state.lifecycle?.action).toBe("delete"); expect(h.api.getBookState).not.toHaveBeenCalled(); expect(h.api.commitPad).not.toHaveBeenCalled();
      if (otherFirst) h.otherDelete(); h.status("online"); const requestChoice = vi.fn();
      expect((await h.sync({ manual: true, requestChoice })).status).toBe("synced");
      if (!otherFirst) { h.otherDelete(); expect((await h.sync({ manual: true, requestChoice })).status).toBe("unchanged"); }
      expect(requestChoice).not.toHaveBeenCalled(); expect(h.api.commitPad).toHaveBeenCalledTimes(otherFirst ? 0 : 1);
      const after = await h.capture(); expect(after.metadata).toMatchObject({ deletedAt: expect.any(Number), deleteAcked: true }); expect(after.state.lifecycle).toBeNull();
      expect(after.payload).toEqual(before.payload); expect(after.pages).toEqual(before.pages); expect((await h.sync()).status).toBe("unchanged");
    }
  });

  it("T8 an acknowledged deliberate delete returns with the hub version and a notice", async () => {
    // This deletes and syncs → the other device restores → this syncs, retaining any unsynced trash content.
    for (const kind of timelineKinds) for (const dirty of [false, true]) {
      const h = await timelineHarness(kind); await h.initial(); await otherDevice(h); await h.switchDevice("this");
      if (dirty) { await h.save("Unsynced before delete"); await putInkPages(h.localKey, [[1, drawing("#aa0000")], [44, drawing("#440000")]]); }
      await deletePadEverywhere(h.api, kind, h.id, undefined, timelineOptions);
      expect((await h.capture()).metadata).toMatchObject({ deleteAcked: true, deleteFollowed: false });
      await h.switchDevice("other"); await h.sync(); expect(await restoreTrashedPad(h.api, kind, h.id, timelineOptions)).toMatchObject({ ok: true });
      expect(h.get().state).toBe("live"); await h.switchDevice("this");
      // The result is named after the restored version, not this device's trashed copy.
      expect(await h.sync()).toMatchObject({ status: "synced", notice: "restored_elsewhere", display: { title: "Book" } });
      const after = await h.capture(); expect(after.metadata?.deletedAt).toBeUndefined(); expect(after.metadata?.deleteFollowed).toBeUndefined();
      expect(titleOf(h, after.record)).toBe("Book"); expect(await recordHash(after.record!)).toBe(await recordHash(h.get().record!));
      expect((await encodedFromRecord(after.pages.find(page => page.pageId === 1)!))?.ops).toEqual(emptyInk.ops);
      if (dirty) {
        const active = after.pages.find(page => page.pageId === 44);
        expect(active ? (await encodedFromRecord(active))?.ops.length : 0).toBe(0);
        const retained = await listRecoveryCopies(kind, h.id);
        const local = retained.find(copy => copy.record?.wire?.[kind === "whiteboard" ? "title" : "name"] === "Unsynced before delete");
        expect(local?.record).toBeDefined();
        expect((await encodedFromRecord(local!.record!.ink!.find(page => page.pageId === 44)!))?.ops).toEqual(drawing("#440000").ops);
      }
      expect(await h.sync()).toMatchObject({ status: "unchanged" });
    }
  });

  it("T9 a device that followed a delete follows the newer restore without a notice", async () => {
    // The other device deletes → this follows → the other device restores → this syncs.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); await otherDevice(h);
      await deletePadEverywhere(h.api, kind, h.id, undefined, timelineOptions); await h.switchDevice("this");
      expect((await h.sync()).notice).toBe("deleted_elsewhere"); expect((await h.capture()).metadata?.deleteFollowed).toBe(true);
      await h.switchDevice("other");
      expect(await restoreTrashedPad(h.api, kind, h.id, timelineOptions)).toMatchObject({ ok: true }); await h.switchDevice("this");
      const result = await h.sync(); expect(result.status).toBe("synced"); expect(result.notice).toBeUndefined();
      expect((await h.capture()).metadata?.deletedAt).toBeUndefined(); expect(titleOf(h, (await h.capture()).record)).toBe("Book");
      expect(await recordHash((await h.capture()).record!)).toBe(await recordHash(h.get().record!));
    }
  });

  it("T10 a delete and restore between syncs downloads the current book without trashing it", async () => {
    // The other device deletes then restores → this unchanged device syncs for the first time since both actions.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); await otherDevice(h);
      await h.save("Restored between syncs"); await putInkPages(h.localKey, [[1, drawing()]]);
      await deletePadEverywhere(h.api, kind, h.id, undefined, timelineOptions);
      expect(await restoreTrashedPad(h.api, kind, h.id, timelineOptions)).toMatchObject({ ok: true }); await h.switchDevice("this");
      const result = await h.sync(); expect(result.status).toBe("synced"); expect(result.notice).toBeUndefined();
      const after = await h.capture(); expect(after.metadata?.deletedAt).toBeUndefined(); expect(titleOf(h, after.record)).toBe("Restored between syncs");
      expect(await recordHash(after.record!)).toBe(await recordHash(h.get().record!));
      expect((await encodedFromRecord(after.pages.find(page => page.pageId === 1)!))?.ops).toEqual(drawing().ops); expect(after.state.appliedBookRev).toBe(h.get().book_rev);
    }
  });

  it("T11 Keep mine recreates a fully swept hub book with every local page", async () => {
    // The other device deletes → this edits offline → hub retained pages are swept → this syncs and chooses Keep mine.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); h.otherDelete(); h.sweepHub(); h.status("offline");
      await h.save("Full local book"); await putInkPages(h.localKey, [[1, drawing()], [44, drawing("#aa0000")]]); const before = await h.capture();
      h.status("online"); expect((await h.sync()).status).toBe("needs_choice");
      const requestChoice = vi.fn(async (conflict: BookConflict, lifecycle: ConflictUiLifecycle) => {
        lifecycle.onMounted(); expect(conflict.lifecycle).toBe(true); return { lifecycle: "local" as const };
      });
      expect((await h.sync({ manual: true, requestChoice })).status).toBe("synced"); expect(h.get().state).toBe("live");
      expect(titleOf(h, h.get().record)).toBe("Full local book"); expect(h.get().pages.map(page => page.page_id).sort((a, b) => a - b)).toEqual([1, 2, 44]);
      expect((await h.hubInk(1))?.ops).toEqual(drawing().ops); expect((await h.hubInk(44))?.ops).toEqual(drawing("#aa0000").ops);
      expect((await h.capture()).payload).toEqual(before.payload);
    }
  });

  it("R1 the restoring device commits immediately and its delete follower comes back", async () => {
    // The other device deletes → this follows → the other device restores and pushes → this follows the live head.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); await otherDevice(h);
      await deletePadEverywhere(h.api, kind, h.id, undefined, timelineOptions); await h.switchDevice("this"); await h.sync();
      await h.switchDevice("other"); h.clearCalls(); const deletedRev = h.get().book_rev;
      expect(await restoreTrashedPad(h.api, kind, h.id, timelineOptions)).toMatchObject({ ok: true });
      expect(h.api.commitPad).toHaveBeenCalled(); expect(h.get().book_rev).toBeGreaterThan(deletedRev); expect(h.get().state).toBe("live");
      expect((await h.capture()).state.lifecycle).toBeNull(); await h.switchDevice("this");
      const result = await h.sync(); expect(result.status).toBe("synced"); expect(result.notice).toBeUndefined();
      expect((await h.capture()).metadata?.deletedAt).toBeUndefined(); expect(await recordHash((await h.capture()).record!)).toBe(await recordHash(h.get().record!));
    }
  });

  it("R2 two deliberate deletions followed by the other restore brings this book back with a notice", async () => {
    // This deletes deliberately → the other device also deletes → the other restores → this syncs.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); await otherDevice(h); await h.switchDevice("this");
      await deletePadEverywhere(h.api, kind, h.id, undefined, timelineOptions); await h.switchDevice("other");
      await deletePadEverywhere(h.api, kind, h.id, undefined, timelineOptions);
      expect((await h.capture()).metadata?.deleteFollowed).toBe(false);
      expect(await restoreTrashedPad(h.api, kind, h.id, timelineOptions)).toMatchObject({ ok: true }); await h.switchDevice("this");
      expect(await h.sync()).toMatchObject({ status: "synced", notice: "restored_elsewhere" });
      expect((await h.capture()).metadata?.deletedAt).toBeUndefined(); expect(await recordHash((await h.capture()).record!)).toBe(await recordHash(h.get().record!));
    }
  });

  it("R3 different trash restores conflict on content rather than lifecycle and retain both books", async () => {
    // Both devices delete their different unsynced copies → both restore offline → the other pushes first → this reconnects.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); await otherDevice(h); await h.save("Other trash copy");
      await putInkPages(h.localKey, [[1, drawing("#aa0000")]]); await h.trash(); await h.sync(); await h.switchDevice("this");
      await h.save("This trash copy"); await putInkPages(h.localKey, [[1, drawing("#0000aa")]]); await h.trash(); await h.sync();
      h.status("offline"); await restoreTrashedPad(h.api, kind, h.id, timelineOptions); const restored = await h.capture();
      await h.switchDevice("other"); await restoreTrashedPad(h.api, kind, h.id, timelineOptions); expect(h.get().state).toBe("live"); await h.switchDevice("this");
      expect((await h.sync()).status).toBe("needs_choice"); expect((await h.capture()).payload).toEqual(restored.payload);
      const requestChoice = vi.fn(async (conflict: BookConflict, lifecycle: ConflictUiLifecycle) => {
        lifecycle.onMounted(); expect(conflict.lifecycle).toBe(false); expect(conflict.record).toBe(true);
        return { record: "server" as const, pages: conflict.pages.map(page => ({ key: page.key, pageId: page.page_id, choice: "server" as const })) };
      });
      const chosen = await h.sync({ manual: true, requestChoice }); expect(chosen.error).toBeUndefined(); expect(chosen.status).toMatch(/^(synced|unchanged)$/); expect(requestChoice).toHaveBeenCalledOnce(); expect(titleOf(h, (await h.capture()).record)).toBe("Other trash copy");
      const retained = await listRecoveryCopies(kind, h.id), mine = retained.find(copy => copy.record?.wire?.[kind === "whiteboard" ? "title" : "name"] === "This trash copy");
      expect(mine?.record).toBeDefined(); expect((await encodedFromRecord(mine!.record!.ink!.find(page => page.pageId === 1)!))?.ops).toEqual(drawing("#0000aa").ops);
      expect((await h.hubInk(1))?.ops).toEqual(drawing("#aa0000").ops);
    }
  });

  it("R4 unchanged devices download restored older content with a newer revision", async () => {
    // The other device restores an old snapshot with old page timestamps → this unchanged device syncs the newer book revision.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); await otherDevice(h); const snapshot = await snapshotOf(h, "Older content");
      expect(await restoreSnapshot(h, snapshot)).toMatchObject({ status: "restored" }); const newRev = h.get().book_rev;
      await h.switchDevice("this"); expect((await h.capture()).state.appliedBookRev).toBeLessThan(newRev);
      expect((await h.sync()).status).toBe("synced"); const after = await h.capture();
      expect(titleOf(h, after.record)).toBe("Older content"); expect((await encodedFromRecord(after.pages.find(page => page.pageId === 1)!))?.ops).toEqual(drawing("#006600").ops);
      expect(after.state.appliedBookRev).toBe(newRev); expect((await h.sync()).status).toBe("unchanged");
    }
  });

  it("R5 a remote snapshot restore conflicts with unsynced local edits without changing them", async () => {
    // The other device restores a snapshot → this edits without syncing → this syncs.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); await otherDevice(h);
      expect(await restoreSnapshot(h, await snapshotOf(h, "Other snapshot"))).toMatchObject({ status: "restored" });
      await h.switchDevice("this"); await h.save("Unsynced here"); await putInkPages(h.localKey, [[1, drawing("#0000aa")]]); const before = await h.capture();
      expect((await h.sync()).status).toBe("needs_choice"); expect(await h.capture()).toEqual(before);
      expect(titleOf(h, h.get().record)).toBe("Other snapshot"); expect((await h.hubInk(1))?.ops).toEqual(drawing("#006600").ops);
    }
  });

  it("R6 online stale snapshot restore changes nothing until force saves the hub head and commits", async () => {
    // The other device edits and syncs → this stale device restores online → Restore anyway archives the hub version then pushes.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); await h.otherRecord("New hub version"); await h.otherPage(1, drawing());
      const before = await h.capture(), head = structuredClone(h.get()), copies = await listRecoveryCopies(kind, h.id), snapshot = await snapshotOf(h, "Forced snapshot"); h.clearCalls();
      expect(await restoreSnapshot(h, snapshot)).toEqual({ status: "stale" }); expect(await h.capture()).toEqual(before); expect(await listRecoveryCopies(kind, h.id)).toEqual(copies);
      expect(h.get()).toEqual(head); expect(h.api.commitPad).not.toHaveBeenCalled(); expect(h.api.putSnapshotCopy).not.toHaveBeenCalled();
      expect(await restoreSnapshot(h, snapshot, true)).toMatchObject({ status: "restored" });
      expect(h.get().state).toBe("live"); expect(titleOf(h, h.get().record)).toBe("Forced snapshot"); expect((await h.hubInk(1))?.ops).toEqual(drawing("#006600").ops);
      await expectHubCopy(h, "New hub version"); expect(h.api.putSnapshotCopy).toHaveBeenCalled();
      expect(vi.mocked(h.api.putSnapshotCopy).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(h.api.commitPad).mock.invocationCallOrder[0]!);
    }
  });

  it("R7 an offline snapshot restore conflicts on reconnect and preserves either rejected version", async () => {
    // This restores offline → the other device edits and syncs → this reconnects, then chooses its restore or the hub version.
    for (const kind of timelineKinds) for (const choice of ["local", "server"] as const) {
      const h = await timelineHarness(kind); await h.initial(); h.status("offline");
      const snapshot = await snapshotOf(h, "Offline restore"); snapshot.ink!.push({ pageId: 44, updatedAt: 1, gz: bytesToB64(packEncodedInk(drawing("#440000"))) });
      expect(await restoreSnapshot(h, snapshot)).toMatchObject({ status: "queued" }); const queued = await h.capture();
      await h.otherRecord("Reconnect hub version"); await h.otherPage(1, drawing()); h.status("online"); h.clearCalls();
      expect((await h.sync()).status).toBe("needs_choice"); expect(await h.capture()).toEqual(queued); expect(h.api.commitPad).not.toHaveBeenCalled();
      const requestChoice = vi.fn(async (conflict: BookConflict, lifecycle: ConflictUiLifecycle) => {
        lifecycle.onMounted(); expect(conflict.lifecycle).toBe(false); expect(conflict.record).toBe(true);
        return { record: choice, pages: conflict.pages.map(page => ({ key: page.key, pageId: page.page_id, choice })) };
      });
      const chosen = await h.sync({ manual: true, requestChoice }); expect(chosen.error).toBeUndefined(); expect(chosen.status).toMatch(/^(synced|unchanged)$/); expect(requestChoice).toHaveBeenCalledOnce();
      if (choice === "local") {
        expect(titleOf(h, h.get().record)).toBe("Offline restore"); expect((await h.hubInk(44))?.ops).toEqual(drawing("#440000").ops);
        await expectHubCopy(h, "Reconnect hub version");
      }
      else {
        const after = await h.capture(); expect(titleOf(h, after.record)).toBe("Reconnect hub version");
        const active = after.pages.find(page => page.pageId === 44); expect(active ? (await encodedFromRecord(active))?.ops.length : 0).toBe(0);
        expect(h.get().pages.some(page => page.page_id === 44)).toBe(false);
        const retained = await listRecoveryCopies(kind, h.id); const restored = retained.find(copy => copy.record?.wire?.[kind === "whiteboard" ? "title" : "name"] === "Offline restore");
        expect(restored).toBeDefined(); expect((await encodedFromRecord(restored!.record!.ink!.find(page => page.pageId === 1)!))?.ops).toEqual(drawing("#006600").ops);
        expect((await encodedFromRecord(restored!.record!.ink!.find(page => page.pageId === 44)!))?.ops).toEqual(drawing("#440000").ops);
      }
    }
  });

  it("R8 an unseen snapshot restore makes the online delete stale", async () => {
    // The other device restores a snapshot → this device never sees it → this deletes online.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); await otherDevice(h);
      expect(await restoreSnapshot(h, await snapshotOf(h, "Unseen restore"))).toMatchObject({ status: "restored" }); await h.switchDevice("this");
      const before = await h.capture(), head = structuredClone(h.get());
      expect(await deletePadEverywhere(h.api, kind, h.id, undefined, timelineOptions)).toEqual({ status: "stale" });
      expect(await h.capture()).toEqual(before); expect(h.get()).toEqual(head);
    }
  });

  it("R9 a stale local snapshot restore against a remote delete asks Keep mine and restores the full book", async () => {
    // The other device deletes → this stale device restores a snapshot offline → reconnect asks Keep mine / Delete.
    for (const kind of timelineKinds) for (const choice of ["local", "server"] as const) {
      const h = await timelineHarness(kind); await h.initial(); h.otherDelete(); h.status("offline");
      expect(await restoreSnapshot(h, await snapshotOf(h, "Resurrected snapshot"))).toMatchObject({ status: "queued" }); h.status("online");
      expect((await h.sync()).status).toBe("needs_choice");
      let choices = 0;
      const requestChoice = vi.fn(async (conflict: BookConflict, lifecycle: ConflictUiLifecycle) => {
        lifecycle.onMounted(); expect(choices++).toBe(0); expect(conflict.lifecycle).toBe(true); return { lifecycle: choice };
      });
      const chosen = await h.sync({ manual: true, requestChoice }); expect(chosen.error).toBeUndefined(); expect(chosen.status).toBe("synced"); expect(requestChoice).toHaveBeenCalledOnce();
      if (choice === "local") {
        expect(h.get().state).toBe("live"); expect(titleOf(h, h.get().record)).toBe("Resurrected snapshot"); expect(h.get().pages.map(page => page.page_id).sort()).toEqual([1, 2]);
        expect((await h.hubInk(1))?.ops).toEqual(drawing("#006600").ops);
      } else {
        expect(h.get().state).toBe("gone"); const after = await h.capture(); expect(after.metadata).toMatchObject({ deletedAt: expect.any(Number), deleteAcked: true }); expect(after.state.lifecycle).toBeNull();
        const copies = await listRecoveryCopies(kind, h.id), restored = copies.find(copy => copy.record?.wire?.[kind === "whiteboard" ? "title" : "name"] === "Resurrected snapshot");
        expect(restored?.record).toBeDefined(); expect((await encodedFromRecord(restored!.record!.ink!.find(page => page.pageId === 1)!))?.ops).toEqual(drawing("#006600").ops);
        expect((await h.sync()).status).toBe("unchanged");
      }
    }
  });

  it("R10 restoring the retained pre-restore copy undoes a snapshot and pushes both edits", async () => {
    // This restores a snapshot → this restores the retained pre-restore book → both changes become hub heads immediately.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); await h.save("Before restore"); await putInkPages(h.localKey, [[1, drawing()]]); await h.sync(); const before = await h.capture(); h.clearCalls();
      expect(await restoreSnapshot(h, await snapshotOf(h, "Temporary snapshot"))).toMatchObject({ status: "restored" }); expect(titleOf(h, h.get().record)).toBe("Temporary snapshot");
      const retained = await listRecoveryCopies(kind, h.id), previous = retained.find(copy => copy.record?.wire?.[kind === "whiteboard" ? "title" : "name"] === "Before restore");
      expect(previous?.record).toBeDefined();
      expect(await restoreRetainedRecord(previous!.id, { client: h.api, ...timelineOptions })).toMatchObject({ status: "restored", kind, id: h.id });
      const after = await h.capture(); expect(after.payload).toEqual(before.payload); expect(titleOf(h, h.get().record)).toBe("Before restore");
      expect((await h.hubInk(1))?.ops).toEqual(drawing().ops); expect(h.api.commitPad).toHaveBeenCalledTimes(2);
      await expectHubCopy(h, "Temporary snapshot", drawing("#006600"));
    }
  });

  it("R11 a foreign PDF snapshot keeps handwriting on the same text across page layouts", async () => {
    // This has a 642-wide PDF → restores another device's 760-wide snapshot → page-50 ink stays at the same text fraction.
    const h = await timelineHarness("annotate"), sizes = Array.from({ length: 60 }, (_, i) => ({ pageNumber: i + 1, width: 600, height: 800 })), hash = "restore-pdf-layout";
    savePdfPageSizes(hash, sizes); await putDocBytes(hash, new Uint8Array([1, 2, 3]).buffer);
    const pdfBoard = (width: number, height: number) => ({ ...board, elements: [{ id: "lcmdink-0-frame", width, height, customData: { lcMdInkFrame: true } }] });
    await saveAnnotateDoc({ id: h.id, name: "Layout.pdf", hash, source: "", docType: "pdf", board: pdfBoard(642, 52667), footnotes: [], agent: [] }); await h.sync();
    const foreign = conflictPdfFrames(sizes, 760, false).find(page => page.pageId === 50)!, fraction = 134 / 800;
    const ink = { ...encodeInkOps([{ kind: "draw" as const, color: "#123456", baseWidth: 2, maxFullness: 1, pressureClip: 1, pressureSensitive: false,
      points: [{ x: 760 * 40 / 600, y: foreign.minY + (foreign.maxY - foreign.minY) * fraction, pressure: .5 }] }]), layout: { w: 760, spread: false } };
    await restoreSnapshot(h, { ...await snapshotOf(h), name: "Restored.pdf", board: pdfBoard(760, 62088), source: "",
      ink: [{ pageId: 50, updatedAt: 1, gz: bytesToB64(packEncodedInk(ink)) }] });
    const capture = await h.capture(), context = pdfInkContextFromRecord(capture.record)!;
    const frame = conflictPdfFrames(sizes, context.layout.w, context.layout.spread).find(page => page.pageId === 50)!;
    const restored = (await encodedFromRecord(capture.pages.find(page => page.pageId === 50)!))!, point = decodeInkOps(restored)[0].points[0];
    expect(restored.layout).toEqual(context.layout); expect(point.x / context.layout.w).toBeCloseTo(40 / 600, 3);
    expect((point.y - frame.minY) / (frame.maxY - frame.minY)).toBeCloseTo(fraction, 3);
  });

  it("R12 fully swept trash is recreated from a hub snapshot or a Retained copy with all pages", async () => {
    // Both devices' trash is swept and the hub retains no pages → this restores a complete immutable snapshot or Retained copy.
    for (const kind of timelineKinds) for (const source of ["hub snapshot", "Retained copy"] as const) {
      const h = await timelineHarness(kind); await h.initial(); await h.save("Swept full book"); await putInkPages(h.localKey, [[1, drawing()], [44, drawing("#aa0000")]]); await h.sync();
      const before = await h.capture(), snapshot = await snapshotFromCapture(h);
      await retainRecoveryCopy({ id: "swept-copy", type: "record", kind, bookId: h.id, provenance: { source: "timeline" },
        record: { meta: before.metadata!, payload: before.payload!, children: before.children, ink: before.pages, wire: before.record! } });
      await h.api.putSnapshotCopy(kind, h.id, "swept-snapshot", { kind, key: h.id, tier: "2h", written_at: 1, payload: snapshot });
      await otherDevice(h); await h.switchDevice("this"); await deletePadEverywhere(h.api, kind, h.id, undefined, timelineOptions);
      const future = Date.now() + 100 * 24 * 60 * 60 * 1000;
      expect(await (kind === "annotate" ? sweepAnnotateTrash(future) : sweepWhiteboardTrash(future))).toContain(h.id);
      await h.switchDevice("other"); await h.sync(); expect(await (kind === "annotate" ? sweepAnnotateTrash(future) : sweepWhiteboardTrash(future))).toContain(h.id);
      h.sweepHub(); expect(h.get().retained_restore_pages).toEqual([]); await h.switchDevice("this"); expect((await h.capture()).payload).toBeNull();
      if (source === "hub snapshot") {
        const copies = await h.api.listSnapshotCopies(kind, h.id), copy = await h.api.getSnapshotCopy(kind, h.id, copies[0]!.content_hash);
        expect(await restoreSnapshot(h, copy!.payload as Partial<PadSnapshot>)).toMatchObject({ status: "restored" });
      } else expect(await restoreRetainedRecord("swept-copy", { client: h.api, ...timelineOptions })).toMatchObject({ status: "restored" });
      expect(h.get().state).toBe("live"); expect(titleOf(h, h.get().record)).toBe("Swept full book"); expect(h.get().pages.map(page => page.page_id).sort((a, b) => a - b)).toEqual([1, 2, 44]);
      expect((await h.hubInk(1))?.ops).toEqual(drawing().ops); expect((await h.hubInk(44))?.ops).toEqual(drawing("#aa0000").ops);
    }
  });

  it("T12 an offline delete cannot discard a newer hub version without a choice", async () => {
    // This queues a delete offline → the other device edits and syncs → this reconnects and chooses.
    for (const kind of timelineKinds) for (const choice of ["local", "server"] as const) {
      const h = await timelineHarness(kind); await h.initial(); const before = await h.capture(); h.status("offline");
      await deletePadEverywhere(h.api, kind, h.id, undefined, timelineOptions); const queued = await h.capture();
      await h.otherRecord("Newer on hub"); await h.otherPage(1, drawing()); await h.otherPage(44, drawing("#aa0000")); const head = h.get().book_rev;
      h.status("online"); h.clearCalls();
      const automatic = await h.sync(); expect(automatic.status).toBe("needs_choice"); expect(automatic.error?.kind).toBe("needs_choice");
      expect(await h.capture()).toEqual(queued); expect(h.api.commitPad).not.toHaveBeenCalled();
      const requestChoice = vi.fn(async (conflict: BookConflict, lifecycle: ConflictUiLifecycle) => {
        lifecycle.onMounted(); expect(conflict.lifecycle).toBe(true); expect(conflict.remote.state).toBe("live"); return { lifecycle: choice };
      });
      const result = await h.sync({ manual: true, requestChoice }); expect(result.error).toBeUndefined(); expect(requestChoice).toHaveBeenCalledOnce();
      const after = await h.capture(); expect(after.state.lifecycle).toBeNull();
      if (choice === "local") {
        expect(result.status).toBe("synced"); expect(h.get().state).toBe("gone");
        expect(vi.mocked(h.api.commitPad).mock.calls[0]![0]).toMatchObject({ action: "delete", base_book_rev: head });
        expect(after.metadata).toMatchObject({ deletedAt: expect.any(Number), deleteAcked: true }); expect(after.payload).toEqual(before.payload); expect(after.pages).toEqual(before.pages);
      } else {
        expect(h.get().state).toBe("live"); expect(h.api.commitPad).not.toHaveBeenCalled(); expect(after.metadata?.deletedAt).toBeUndefined();
        expect(after.record?.[kind === "whiteboard" ? "title" : "name"]).toBe("Newer on hub");
        expect(after.pages.map(page => page.pageId).sort((a, b) => a - b)).toEqual([1, 2, 44]);
        expect((await h.hubInk(1))?.ops).toEqual(drawing().ops);
      }
      expect((await h.sync()).status).toBe("unchanged");
    }
  });

  it("T13 a hub delete between capture and commit preserves data for the next pass", async () => {
    // This captures a clean or edited book → the other device deletes before commit / head check → this syncs again.
    for (const kind of timelineKinds) for (const edited of [false, true]) {
      const h = await timelineHarness(kind); await h.initial();
      if (edited) { await h.save("My edits"); await putInkPages(h.localKey, [[1, drawing()]]); }
      const before = await h.capture(); h.clearCalls();
      if (edited) {
        const commit = vi.mocked(h.api.commitPad).getMockImplementation()!; let deleted = false;
        vi.mocked(h.api.commitPad).mockImplementation(async (...args) => { if (!deleted) { deleted = true; h.otherDelete(); } return commit(...args); });
      } else {
        const check = vi.mocked(h.api.checkBookHead).getMockImplementation()!; let deleted = false;
        vi.mocked(h.api.checkBookHead).mockImplementation(async (...args) => { if (!deleted) { deleted = true; h.otherDelete(); } return check(...args); });
      }
      const first = await h.sync(); expect(h.get().state).toBe("gone");
      const after = await h.capture(); expect(after.payload).toEqual(before.payload); expect(after.pages).toEqual(before.pages);
      const next = await h.sync();
      if (edited) {
        expect(first.status).not.toBe("synced"); expect(after.metadata?.deletedAt).toBeUndefined(); expect(next.status).toBe("needs_choice"); expect(next.error?.kind).toBe("needs_choice");
      } else {
        expect([first, next]).toContainEqual(expect.objectContaining({ status: "synced", notice: "deleted_elsewhere" }));
        expect((await h.capture()).metadata).toMatchObject({ deletedAt: expect.any(Number), deleteAcked: true, deleteFollowed: true });
      }
    }
  });

  it("T14 autosync never opens a choice window for edited books deleted elsewhere", async () => {
    // This has unsynced edits open → the other device deletes → a non-manual autosync pass runs.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); await h.save("Open unsynced edits"); await putInkPages(h.localKey, [[1, drawing()]]); h.otherDelete();
      const before = await h.capture(), requestChoice = vi.fn(); h.clearCalls();
      const result = await h.sync({ manual: false, requestChoice }); expect(result.status).toBe("needs_choice"); expect(result.error?.kind).toBe("needs_choice");
      expect(requestChoice).not.toHaveBeenCalled(); expect(h.api.commitPad).not.toHaveBeenCalled(); expect(await h.capture()).toEqual(before);
    }
  });

  it("T15 an edit before follow-delete publication aborts the publication", async () => {
    // The other device deletes → this decides to follow → a local edit lands before publish → the next pass asks.
    for (const kind of timelineKinds) {
      const h = await timelineHarness(kind); await h.initial(); h.otherDelete(); h.clearCalls(); let edited = false;
      const result = await h.sync({ beforePublish: async () => { if (!edited) { edited = true; await h.save("Edit during publication"); await putInkPages(h.localKey, [[1, drawing()]]); } } });
      expect(edited).toBe(true); expect(result.error?.kind).toBe("local_changed"); expect(result.status).toBe("failed");
      const after = await h.capture(); expect(after.metadata?.deletedAt).toBeUndefined(); expect(after.state.lifecycle).toBeNull();
      expect(after.record?.[kind === "whiteboard" ? "title" : "name"]).toBe("Edit during publication"); expect(after.pages.find(page => page.pageId === 1)?.inkC?.ops).toEqual(drawing().ops);
      const next = await h.sync(); expect(next.error?.kind).toBe("needs_choice"); expect(h.api.commitPad).not.toHaveBeenCalled();
    }
  });

  it("T18 reopening a deleted PDF creates a new book and both sync without conflict", async () => {
    // This deletes a PDF book → opens the same PDF in the same millisecond → syncs the old and new book.
    const h = await timelineHarness("annotate"); vi.spyOn(Date, "now").mockReturnValue(1000);
    const bytes = new TextEncoder().encode("%PDF-1.7\nshared source\n%%EOF").buffer, hash = hashBytes(bytes); await putDocBytes(hash, bytes);
    const input = { name: "Shared.pdf", hash, docType: "pdf" as const, source: "", board, footnotes: [], agent: [] };
    const old = await saveAnnotateDoc(input); await putInkPages(`md:${old.id}`, [[1, drawing()]]);
    const initial = await syncBook(h.api, "annotate", old.id, undefined, timelineOptions); expect(initial.status, initial.error?.message).toBe("synced");
    await deletePadEverywhere(h.api, "annotate", old.id, undefined, timelineOptions); expect((await captureBook({ kind: "annotate", id: old.id })).metadata?.deletedAt).toBeDefined();
    expect(await findAnnotateDocByHash(hash)).toBeNull();
    const fresh = await saveAnnotateDoc(input); expect(fresh.id).not.toBe(old.id); expect(fresh.deletedAt).toBeUndefined();
    expect((await findAnnotateDocByHash(hash))?.id).toBe(fresh.id); expect((await getAnnotateDoc(old.id))?.deletedAt).toBeDefined();
    await putInkPages(`md:${fresh.id}`, [[1, emptyInk]]);
    expect((await syncBook(h.api, "annotate", old.id, undefined, timelineOptions)).status).toBe("unchanged");
    expect((await syncBook(h.api, "annotate", fresh.id, undefined, timelineOptions)).status).toBe("synced");
    expect(h.get("annotate", old.id).state).toBe("gone"); expect(h.get("annotate", fresh.id).state).toBe("live"); expect(await getDocBytes(hash)).toEqual(bytes);
    expect((await h.hubInk(1, "annotate", old.id))?.ops).toEqual(drawing().ops); expect((await h.hubInk(1, "annotate", fresh.id))?.ops).toEqual(emptyInk.ops);
  });
});
