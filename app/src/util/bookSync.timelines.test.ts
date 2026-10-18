import { afterEach, describe, expect, it, vi } from "vitest";
import { type BookConflict, type BookSyncOptions, syncBook } from "./bookSync";
import type { ConflictUiLifecycle } from "./conflictUiWait";
import { captureBook } from "./bookSnapshot";
import { putInkPages } from "./inkPageStore";
import { deletePadEverywhere } from "./padSync";
import { bookFailureMessage } from "./bookSyncMessages";
import { findAnnotateDocByHash, getAnnotateDoc, saveAnnotateDoc } from "./annotateStore";
import { getDocBytes, hashBytes, putDocBytes } from "./docBytes";
import { recordHash } from "./syncContent";
import { board, closeTimelineHarness, drawing, emptyInk, timelineHarness, timelineKinds, timelineOptions } from "./bookSyncTestHarness";

afterEach(closeTimelineHarness);

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
