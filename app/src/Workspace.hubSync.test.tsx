/** @vitest-environment jsdom */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { Workspace } from "./Workspace";
import type { ShellValue, WorkspaceApi } from "./shellContext";
import type { BoardHandle } from "./canvas/BoardHandle";
import type { Board } from "./canvas/Board";
import type { AnnotateDoc } from "./util/annotateStore";
import { hashMarkdown } from "./util/annotateStore";
import type { TabRecord } from "./util/tabs";
import type { BookPassOptions, BookPassResult } from "./util/bookSyncPass";
import type { BookConflict } from "./util/bookSync";
import type { HubSyncControlProps } from "./components/HubSyncControl";
import { PAD_HUB_WINDOW_EVENT, type PadHubWindowDetail } from "./util/padSync";
import { saveHubSyncWindowPill } from "./util/hubSyncWindowPillPref";
import { savePadHub } from "./util/padHub";
import { BOOK_PASS_STATUS_EVENT } from "./util/bookSyncPass";
import { LcApiError } from "./api/client";
import { HOLD_FILL_MS } from "./util/gesture";

type PaperProps = ComponentProps<typeof import("./modes/AnnotateDocument").AnnotateDocument>;
type SplitProps = ComponentProps<typeof import("./components/HubConflictSplit").HubConflictSplit>;
const mocks = vi.hoisted(() => ({
  shell: {} as ShellValue, api: null as WorkspaceApi | null, board: {} as BoardHandle,
  sync: null as HubSyncControlProps | null, split: null as SplitProps | null,
  doc: null as AnnotateDoc | null, save: vi.fn(), pass: vi.fn(), inkPages: vi.fn(),
}));

// Keep Workspace, the tab's Sync callback, HubSyncControl and the conflict
// lifecycle real. Canvas/layout, storage and the book transaction are boundaries.
vi.mock("./shellContext", () => ({ useShell: () => mocks.shell }));
vi.mock("./canvas/boardChunk", async () => {
  const { useImperativeHandle } = await import("react");
  const BoardView = (props: ComponentProps<typeof Board>) => {
    useImperativeHandle(props.ref, () => mocks.board, []);
    return <section>{props.pageContent}</section>;
  };
  return { peekBoardComponent: () => BoardView };
});
vi.mock("./modes/AnnotateDocument", async () => {
  const { useEffect } = await import("react");
  return { AnnotateDocument: (props: PaperProps) => {
    useEffect(() => { props.onMeasure?.(2400); }, [props.source, props.onMeasure]);
    return <article>{props.source}</article>;
  } };
});
vi.mock("./components/HubSyncControl", async original => {
  const real = await original<typeof import("./components/HubSyncControl")>();
  return { ...real, HubSyncControl: (props: HubSyncControlProps) => {
    mocks.sync = props;
    return <real.HubSyncControl {...props} />;
  } };
});
vi.mock("./components/HubConflictSplit", async () => {
  const { useEffect } = await import("react");
  return { HubConflictSplit: (props: SplitProps) => {
    mocks.split = props;
    useEffect(() => { props.onMounted?.(); }, [props.onMounted]);
    return <section role="dialog" aria-label="Sync conflict">
      <button onClick={() => props.onResolve({ pick: "server", ink: "server" })}>Keep server</button>
      <button onClick={props.onCancel}>Cancel sync</button>
    </section>;
  } };
});
vi.mock("./components/LoadingDoodle", () => ({ LoadingDoodle: () => null }));
vi.mock("./canvas/pageTurn/PageTurn", () => ({ PageTurn: () => null }));
vi.mock("./util/bootSettled", () => ({ afterBootSettled: () => new Promise(() => {}) }));
vi.mock("./util/loadingDoodleActivity", () => ({ isLoadingDoodleActive: () => false, waitForLoadingDoodleIdle: async () => {} }));
vi.mock("./util/annotateStore", async original => ({
  ...await original<typeof import("./util/annotateStore")>(),
  listAnnotateDocs: () => [], migrateAnnotateKeysToId: async () => {},
  getAnnotateDoc: async (id: string) => id === mocks.doc?.id ? mocks.doc : null,
  getAnnotateDocMeta: () => mocks.doc,
  findAnnotateDocByHash: async () => null, listAnnotateDocsByHash: () => [], findStaleAnnotateDoc: () => null,
  saveAnnotateDoc: (...args: unknown[]) => mocks.save(...args),
}));
vi.mock("./util/whiteboardStore", async original => ({
  ...await original<typeof import("./util/whiteboardStore")>(), listWhiteboardNotebooks: () => [],
}));
vi.mock("./util/contentStore", async original => ({
  ...await original<typeof import("./util/contentStore")>(), repairContentStore: async () => ({ promoted: 0, remaining: 0 }),
}));
vi.mock("./util/inkPageStore", async original => ({
  ...await original<typeof import("./util/inkPageStore")>(),
  getInkPages: (...args: unknown[]) => mocks.inkPages(...args),
}));
vi.mock("./util/bookSyncPass", async original => ({
  ...await original<typeof import("./util/bookSyncPass")>(),
  syncBookPass: (...args: unknown[]) => mocks.pass(...args),
}));
vi.mock("./util/padHubStatus", async original => ({
  ...await original<typeof import("./util/padHubStatus")>(), isPadHubOffline: () => true,
}));

const tab: TabRecord = { id: "annotate", kind: "annotate", title: "Book.md", docId: "book", hash: "book-hash", source: "# Book", docType: "markdown", dirty: false, lastActive: 0, indexed: "idle" };
const result = (): BookPassResult => ({ modern: true, books: [{ kind: "annotate", id: "book", status: "synced", committed: true }], notices: [], cancelled: false });
let root: Root;
let mounted = false;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function mount() {
  mounted = true;
  await act(async () => { root.render(<Workspace tab={tab} active showing />); });
  await act(async () => { await vi.dynamicImportSettled(); });
  for (let i = 0; i < 12; i++) await advance(250);
  expect(mocks.shell.setError).not.toHaveBeenCalledWith(expect.any(String));
  expect(mocks.api!.isLoadActive()).toBe(false);
  mocks.save.mockClear(); vi.mocked(mocks.board.restoreBoard).mockClear(); mocks.inkPages.mockClear();
}
async function tapSync() {
  const chrome = vi.mocked(mocks.shell.setChrome).mock.lastCall?.[0];
  expect(chrome?.docIndex?.onSync).toBeTypeOf("function");
  await act(async () => { chrome!.docIndex!.onSync!(); });
}
async function reload(id = "book", op: PadHubWindowDetail["op"] = "reload") {
  await act(async () => { window.dispatchEvent(new CustomEvent(PAD_HUB_WINDOW_EVENT, { detail: { kind: "annotate", id, op } })); });
}
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find(el => el.textContent === text);
  expect(button, text).toBeTruthy();
  await act(async () => { button!.click(); });
}
function conflict(): BookConflict {
  return { capture: { kind: "annotate", id: "book", metadata: null, pages: [], record: { id: "book", name: "Book.md", board: mocks.doc!.board } },
    remote: { record: { id: "book", name: "Hub.md", board: mocks.doc!.board } }, record: true, pages: [],
  } as unknown as BookConflict;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  localStorage.clear(); vi.clearAllMocks(); savePadHub({ url: "http://isolated.test", token: "test" });
  mocks.api = null; mocks.sync = null; mocks.split = null;
  mocks.doc = { id: "book", name: "Book.md", hash: hashMarkdown("# Book"), source: "# Book", docType: "markdown", updatedAt: 1,
    board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } }, footnotes: [],
  };
  mocks.save.mockReset().mockImplementation(async input => ({ ...mocks.doc, ...input }));
  mocks.pass.mockReset().mockResolvedValue(result());
  mocks.inkPages.mockReset().mockResolvedValue(new Map());
  const noop = () => vi.fn();
  mocks.board = {
    instanceId: 1, getElements: vi.fn(() => []), getInkStrokes: vi.fn(() => []), getInkOps: vi.fn(() => []),
    hasRasterInk: vi.fn(() => false), isPdfInkLayoutPending: vi.fn(() => false), isInking: vi.fn(() => false),
    restoreBoard: noop(), setElements: noop(), applyThemeInk: noop(), stripCoachViz: noop(),
    waitForTemplate: vi.fn(async () => {}), settleFitView: vi.fn(async () => {}), restoreView: noop(),
    primeInkSnap: vi.fn(async () => {}), syncDocumentScrollBounds: noop(), armReadingScroll: noop(), fitCodeToSource: noop(),
    getInkOpCount: vi.fn(() => 0), getInkRevision: vi.fn(() => 0), dirtyInkPageCount: vi.fn(() => 0),
    takeDirtyInkPages: vi.fn(() => new Map()), markInkPagesFlushed: noop(),
    inkFingerprint: vi.fn(() => "ink"), seedTemplate: noop(), setInkDoc: noop(), setInkOps: noop(), setInkSpread: noop(),
    saveBoard: vi.fn(() => ({ v: 1, elements: [], appState: {} })),
  } as unknown as BoardHandle;
  const host = document.createElement("div"), chrome = document.createElement("div"), agentPanel = document.createElement("div");
  document.body.append(host, chrome, agentPanel); root = createRoot(host);
  mocks.shell = {
    client: { putAgentSession: vi.fn(async () => {}), pingPadSync: vi.fn(async () => ({ features: ["atomic_book_sync_v1"], books: [] })),
      getDocIndex: vi.fn(async () => ({ indexed: true, page_count: 1, embed_state: "full" })) },
    mobile: false, serverLinkRef: { current: "online" }, themeId: "paper", readingSize: "M", autosaveMs: 1000,
    testForward: "off", recognizer: null, capabilities: null, coachFlags: {}, llmLink: "offline", error: null,
    browseMotion: "idle", holdBrowseOverlay: false, session: { started_at: 0, active_list: null, queue: [], problems: {}, reveals: {} },
    navigateBySession: false, bankFilters: {}, tabsRef: { current: { tabs: [tab], activeId: tab.id, groups: [] } },
    headerSlots: { left: null, center: null, right: chrome, chrome, boardChrome: null, agentPanel },
    setThemeId: noop(), setAutosaveMs: noop(), setTestForward: noop(), setPdfFilmOpen: noop(), setSettingsOpen: noop(), setNotice: noop(),
    setError: noop(), announceAutosave: noop(), setBrowseMotion: noop(), setHoldBrowseOverlay: noop(), setSession: noop(),
    refreshSession: vi.fn(async () => {}), setNavigateBySession: noop(), setBankFilters: noop(), openWorkspace: noop(),
    focusTab: noop(), openPracticePicker: noop(), closeTab: noop(), splitTabs: noop(), patchTab: noop(), webPush: noop(), webStep: noop(),
    setChrome: noop(), setWorkspaceApi: vi.fn((_id, api) => { mocks.api = api; }), setShellLoadActive: noop(),
    shellLoadActive: false, takeUserLoad: vi.fn(() => false), onMissingContent: noop(),
  } as unknown as ShellValue;
});
afterEach(() => {
  if (mounted) act(() => root.unmount());
  mounted = false; document.body.textContent = "";
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("a tab Sync tap prepares the live pad, reports progress, ignores window reloads until the walk ends, and reloads after it", async () => {
  const pass = deferred<BookPassResult>();
  mocks.pass.mockImplementation((_client, options: BookPassOptions) => {
    options.onProgress?.(1, 2, { kind: "annotate", id: "book" });
    return pass.promise;
  });
  await mount(); await tapSync();
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ id: "book", board: expect.anything() }));
  expect(mocks.pass).toHaveBeenCalledWith(mocks.shell.client, expect.objectContaining({ only: true, selected: { kind: "annotate", id: "book" } }));
  expect(mocks.sync!.report).toMatchObject({ stage: "pad", progress: { done: 1, total: 2 } });
  await reload(); expect(mocks.board.restoreBoard).not.toHaveBeenCalled(); expect(mocks.inkPages).not.toHaveBeenCalled();
  await act(async () => { pass.resolve(result()); });
  expect(mocks.sync!.report?.stage).toBe("synced");
  expect(mocks.board.restoreBoard).toHaveBeenCalledTimes(1);
  await reload(); expect(mocks.board.restoreBoard).toHaveBeenCalledTimes(2);
});

type IndexClient = { getDocIndex: ReturnType<typeof vi.fn>; embedDoc?: ReturnType<typeof vi.fn> };
const docIndexChrome = () => vi.mocked(mocks.shell.setChrome).mock.lastCall?.[0]?.docIndex;

it("says the hub is offline when it does not answer during Index, and does not ask again by itself", async () => {
  // The hub lives in the desktop app; while it restarts, nothing answers.
  const client = mocks.shell.client as unknown as IndexClient;
  await mount();
  client.getDocIndex.mockRejectedValue(new LcApiError("Could not reach the hub at http://isolated.test.", 0));
  await tapSync();
  for (let i = 0; i < 8; i++) await advance(250);
  expect(docIndexChrome()?.indexNote).toEqual({ kind: "hub-offline", detail: null });
  expect(docIndexChrome()?.status).not.toBe("error");
  expect(mocks.sync!.report?.stage).toBe("synced");
  const calls = client.getDocIndex.mock.calls.length;
  await advance(600_000);
  expect(client.getDocIndex.mock.calls.length).toBe(calls);
});

it("calls a failure the hub answered with an index error, not the hub being offline", async () => {
  const client = mocks.shell.client as unknown as IndexClient;
  await mount();
  client.getDocIndex.mockRejectedValue(new LcApiError("extract failed", 500));
  await tapSync();
  for (let i = 0; i < 8; i++) await advance(250);
  expect(docIndexChrome()?.status).toBe("error");
  expect(docIndexChrome()?.error).toBe("extract failed");
  expect(docIndexChrome()?.indexNote).toBeNull();
});

it("keeps a document indexed and the sync successful when the embedding model does not answer", async () => {
  const client = mocks.shell.client as unknown as IndexClient;
  client.embedDoc = vi.fn(async () => ({ done: 0, total: 4, reason: "error sending request: connection refused" }));
  await mount();
  client.getDocIndex.mockResolvedValue({ indexed: true, page_count: 1, embed_state: "none", configured_model: "qwen-embed" });
  await tapSync();
  for (let i = 0; i < 8; i++) await advance(250);
  expect(client.embedDoc).toHaveBeenCalledTimes(1);
  expect(docIndexChrome()?.status).toBe("indexed");
  expect(docIndexChrome()?.indexNote).toEqual({ kind: "embed-offline", detail: "error sending request: connection refused" });
  expect(mocks.sync!.report).toMatchObject({ stage: "synced" });
  expect(mocks.sync!.report?.error ?? null).toBeNull();
});

it("treats an embed request that fails outright as embedding offline too", async () => {
  const client = mocks.shell.client as unknown as IndexClient;
  client.embedDoc = vi.fn(async () => { throw new LcApiError("No response from the hub", 0); });
  await mount();
  client.getDocIndex.mockResolvedValue({ indexed: true, page_count: 1, embed_state: "none", configured_model: "qwen-embed" });
  await tapSync();
  for (let i = 0; i < 8; i++) await advance(250);
  expect(docIndexChrome()?.status).toBe("indexed");
  expect(docIndexChrome()?.indexNote).toMatchObject({ kind: "embed-offline" });
});

it("does not call embedding offline when no model is set at all", async () => {
  const client = mocks.shell.client as unknown as IndexClient;
  client.embedDoc = vi.fn(async () => ({ done: 0, total: 4, reason: "no embedding model is configured" }));
  await mount();
  client.getDocIndex.mockResolvedValue({ indexed: true, page_count: 1, embed_state: "none", configured_model: "" });
  await tapSync();
  for (let i = 0; i < 8; i++) await advance(250);
  expect(docIndexChrome()?.status).toBe("indexed");
  expect(docIndexChrome()?.indexNote).toBeNull();
});

it("shows a book notice under Synced instead of as an index error", async () => {
  mocks.pass.mockResolvedValue({ ...result(), notices: [{ kind: "links" }] });
  await mount();
  await tapSync();
  for (let i = 0; i < 8; i++) await advance(250);
  expect(mocks.sync!.report).toMatchObject({ stage: "synced", notice: "Links didn't sync." });
  expect(docIndexChrome()?.walkNotice).toBe("Links didn't sync.");
  expect(docIndexChrome()?.status).toBe("indexed");
});

it("runs the tab's Sync from the Annotate menu's [Sync | Link], and steps the menu aside for a conflict", async () => {
  mocks.pass.mockImplementation(async (_client, options: BookPassOptions) => {
    await options.requestChoice!(conflict(), { signal: options.signal!, onMounted: vi.fn(), onUnavailable: vi.fn() });
    return result();
  });
  await mount();
  const header = [...document.querySelectorAll("button")].find(el => el.getAttribute("aria-label") === "Markdown documents: tap to save now, hold for save / open menu")!;
  await act(async () => { header.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await advance(HOLD_FILL_MS + 50);
  await act(async () => { header.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })); });
  await advance(400);
  const sync = document.querySelector<HTMLButtonElement>(".lc-annotate-context .lc-sync-link-sync");
  expect(sync?.textContent).toBe("Sync");
  await act(async () => { sync!.click(); });
  expect(mocks.pass).toHaveBeenCalledWith(mocks.shell.client, expect.objectContaining({ only: true, selected: { kind: "annotate", id: "book" } }));
  for (let i = 0; i < 4; i++) await advance(250);
  expect(document.querySelector('[aria-label="Sync conflict"]')).toBeTruthy();
  expect(document.querySelector(".lc-annotate-context")).toBeNull();
});

it("holds autosave throughout an asynchronous hub apply and releases it afterwards", async () => {
  await mount();
  const ink = deferred<Map<number, never>>(); mocks.inkPages.mockReturnValueOnce(ink.promise);
  await reload(); expect(mocks.board.restoreBoard).toHaveBeenCalledTimes(1);
  // A visibly changed board would be persisted by the next real autosave tick.
  vi.mocked(mocks.board.getElements).mockReturnValue([{ id: "hub-shape", type: "rectangle", x: 1, y: 2, width: 30, height: 40 }] as never);
  await advance(2100); expect(mocks.save).not.toHaveBeenCalled();
  await act(async () => { ink.resolve(new Map<number, never>()); });
  await advance(1100); expect(mocks.save).toHaveBeenCalledTimes(1);
});

it.each(["error", "cancel"] as const)("clears the walk guard after %s so window reloads resume", async ending => {
  const pass = deferred<BookPassResult>(); mocks.pass.mockReturnValue(pass.promise);
  await mount(); await tapSync(); await reload(); expect(mocks.board.restoreBoard).not.toHaveBeenCalled();
  await act(async () => { if (ending === "error") pass.reject(new Error("Hub unavailable")); else pass.resolve({ ...result(), cancelled: true }); });
  if (ending === "error") expect(mocks.sync!.report?.error).toBe("Hub unavailable");
  else expect(mocks.sync!.report).toBeNull();
  await reload(); expect(mocks.board.restoreBoard).toHaveBeenCalledTimes(1);
});

it.each(["Keep server", "Cancel sync"])("hands a conflict to the merge split and resumes or cancels with %s", async choice => {
  const decision = vi.fn();
  mocks.pass.mockImplementation(async (_client, options: BookPassOptions) => {
    const answer = await options.requestChoice!(conflict(), { signal: options.signal!, onMounted: vi.fn(), onUnavailable: vi.fn() });
    decision(answer); return result();
  });
  await mount(); await tapSync();
  expect(document.querySelector('[aria-label="Sync conflict"]')).toBeTruthy();
  expect(mocks.split!.conflict).toMatchObject({ id: "book", modernChoice: true, stage: "pad" });
  expect(mocks.sync!.report?.waiting).toBe("conflict"); expect(mocks.sync!.showDock).toBe(false);
  await reload(); expect(mocks.board.restoreBoard).not.toHaveBeenCalled();
  await click(choice);
  expect(document.querySelector('[aria-label="Sync conflict"]')).toBeNull();
  if (choice === "Keep server") {
    expect(decision).toHaveBeenCalledWith(expect.objectContaining({ record: "server" }));
    expect(mocks.sync!.report?.stage).toBe("synced"); expect(mocks.board.restoreBoard).toHaveBeenCalledTimes(1);
  } else {
    expect(decision).not.toHaveBeenCalled(); expect(mocks.sync!.report).toBeNull();
    expect(mocks.board.restoreBoard).not.toHaveBeenCalled();
    await reload(); expect(mocks.board.restoreBoard).toHaveBeenCalledTimes(1);
  }
});

it("updates the optional window pill preference without losing the tab Sync tap, and closes even during a walk", async () => {
  const pass = deferred<BookPassResult>(); mocks.pass.mockReturnValue(pass.promise);
  await mount(); expect(document.querySelector(".lc-hub-sync")).toBeNull();
  act(() => saveHubSyncWindowPill(true)); expect(document.querySelector(".lc-hub-sync")).toBeTruthy();
  act(() => saveHubSyncWindowPill(false)); expect(document.querySelector(".lc-hub-sync")).toBeNull();
  await tapSync(); await reload("other", "close"); expect(mocks.shell.closeTab).not.toHaveBeenCalled();
  await reload("book", "close"); expect(mocks.shell.closeTab).toHaveBeenCalledWith(tab.id);
});

it("keeps passive book status from overwriting a running walk, then shows its result after the walk", async () => {
  const pass = deferred<BookPassResult>(); mocks.pass.mockReturnValue(pass.promise);
  const publish = async (summary: string | null = null) => {
    await act(async () => { window.dispatchEvent(new CustomEvent(BOOK_PASS_STATUS_EVENT, { detail: { passive: true, result: result(), summary } })); });
  };
  await mount(); await publish(); expect(mocks.sync!.report?.stage).toBe("synced");
  await tapSync(); await publish("Background failure");
  expect(mocks.sync!.report).toEqual({ stage: "pad", progress: null });
  await act(async () => { pass.resolve(result()); });
  await publish("Background failure"); expect(mocks.sync!.report?.error).toBe("Background failure");
});

it("releases the apply guards after a failed reload and leaves an unsaved live board alone", async () => {
  await mount(); mocks.inkPages.mockRejectedValueOnce(new Error("Ink read failed"));
  await reload();
  expect(mocks.shell.setNotice).toHaveBeenCalledWith("The page changed during sync. Tap Sync to try again.");
  await reload(); expect(mocks.board.restoreBoard).toHaveBeenCalledTimes(2);
  vi.mocked(mocks.board.getElements).mockReturnValue([{ id: "local-shape", type: "rectangle", x: 1, y: 2, width: 30, height: 40 }] as never);
  await reload(); expect(mocks.board.restoreBoard).toHaveBeenCalledTimes(2);
  await advance(1100); expect(mocks.save).toHaveBeenCalledTimes(1);
});
