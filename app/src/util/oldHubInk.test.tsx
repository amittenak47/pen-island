/** @vitest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LcClient } from "../api/client";
import { HubSyncControl, type HubSyncWalkHost } from "../components/HubSyncControl";
import { syncInkPages, pullInkPagesOverLocal, pushInkPagesToHub } from "./inkSync";
import { applyPadSyncPing, discoverHubPads, pullPads, resetPadSyncForTests } from "./padSync";
import { captureBook } from "./bookSnapshot";
import { closeDbForTests } from "./idb";
import { putInkPages } from "./inkPageStore";
import { encodeInkOps } from "../canvas/inkCodec";
import { saveWhiteboardNotebook } from "./whiteboardStore";
import { resetLocalBookStoreForTests } from "./localBookStore";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { PAD_HUB_KEY } from "./padHub";
import { putPadRecord } from "./padRecordUpload";

const board = { v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
let api: LcClient;
beforeEach(async () => {
  await closeDbForTests(); resetPadSyncForTests(); resetLocalBookStoreForTests(); resetBookCoordinatorForTests();
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); localStorage.setItem("whiteboard.hubAutoSync.v1", "on"); localStorage.setItem(PAD_HUB_KEY, JSON.stringify({ url: "http://hub", token: "test" }));
  api = { pingPadSync: vi.fn(async () => ({ features: ["atomic_commit"], now: 9, annotate: [], problem: [], whiteboard: [],
    ink: [{ kind: "whiteboard", key: "book", page_id: 1, updated_at: 999 }], gone: [], snapshots: [], edges: [], gone_edges: [] })),
    getInkPage: vi.fn(), putInkPage: vi.fn(), listWhiteboardPads: vi.fn(async () => []), listAnnotatePads: vi.fn(async () => []),
    putWhiteboardPad: vi.fn() } as unknown as LcClient;
  await saveWhiteboardNotebook({ id: "book", title: "Book", board, pageCount: 1 });
  await putInkPages("wb:book", [[1, encodeInkOps([])]]);
});
afterEach(async () => { await closeDbForTests(); resetLocalBookStoreForTests(); vi.unstubAllGlobals(); });
it.each(["sync", "pull", "push", "record", "discover", "library", "automatic"])("refuses old-hub %s before any legacy ink transfer or overwrite", async mode => {
  const before = await captureBook({ kind: "whiteboard", id: "book" });
  const work = () => mode === "sync" ? syncInkPages(api, [], [{ kind: "whiteboard", key: "book" }], 0, { strict: true })
    : mode === "pull" ? pullInkPagesOverLocal(api, "whiteboard", "book", [1])
    : mode === "push" ? pushInkPagesToHub(api, "whiteboard", "book")
    : mode === "record" ? putPadRecord(api, "whiteboard", { id: "book", title: "Book", page_count: 1, updated_at: 1,
      board: { ...board, inkPages: { v: 1, pageIds: [1] } }, agent: [] }, [])
    : mode === "discover" ? discoverHubPads(api) : mode === "library" ? pullPads(api) : applyPadSyncPing(api);
  await expect(work()).rejects.toThrow("Update the desktop app to sync safely.");
  expect(api.getInkPage).not.toHaveBeenCalled(); expect(api.putInkPage).not.toHaveBeenCalled();
  expect(api.putWhiteboardPad).not.toHaveBeenCalled();
  expect(await captureBook({ kind: "whiteboard", id: "book" })).toEqual(before);
});
it("shows the update-hub error on every manual attempt without entering the legacy walk", async () => {
  const error = vi.fn(), walk = vi.fn();
  const host = { doc: () => null, pad: async () => ({ kind: "whiteboard", id: "book", buildBody: () => ({}), hubAckUpdatedAt: () => 0 }),
    emitReload: vi.fn(), inkSince: () => 0, onWalkProgress: walk, onIndexError: error, onIndexOffline: vi.fn(), onIndexDone: vi.fn(), onIndexProgress: vi.fn() } as unknown as HubSyncWalkHost;
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  try {
    await act(async () => root.render(<HubSyncControl client={api} host={host} />));
    for (let i = 0; i < 2; i++) await act(async () => { (element.querySelector("button") as HTMLButtonElement).click(); });
    // A walk failure, said on the pill each tap; it is not an index error.
    expect(walk.mock.calls.map(([report]) => report?.error).filter(Boolean)).toEqual(["Update the desktop app to sync safely.", "Update the desktop app to sync safely."]);
    expect(error.mock.calls.filter(([message]) => message)).toEqual([]);
    expect(api.putWhiteboardPad).not.toHaveBeenCalled(); expect(api.getInkPage).not.toHaveBeenCalled(); expect(api.putInkPage).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); element.remove(); }
});

it("uses Library Pull's first capability response without a second legacy fallback probe", async () => {
  const ping = await api.pingPadSync(0);
  vi.mocked(api.pingPadSync).mockResolvedValueOnce(ping).mockResolvedValue({ ...ping, features: ["atomic_book_sync_v1"] });
  vi.mocked(api.pingPadSync).mockClear();
  await expect(pullPads(api)).rejects.toThrow("Update the desktop app to sync safely.");
  expect(api.pingPadSync).toHaveBeenCalledOnce(); expect(api.listWhiteboardPads).not.toHaveBeenCalled();
  expect(api.getInkPage).not.toHaveBeenCalled(); expect(api.putInkPage).not.toHaveBeenCalled();
});
