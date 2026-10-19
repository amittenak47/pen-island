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

it("asks the hub again after the walk's index step fails, and clears the error once it has the index", async () => {
  // The hub lives in the desktop app; while it restarts, the walk's index step fails.
  const client = mocks.shell.client as unknown as { getDocIndex: ReturnType<typeof vi.fn> };
  const status = () => vi.mocked(mocks.shell.setChrome).mock.lastCall?.[0]?.docIndex?.status;
  await mount();
  client.getDocIndex.mockRejectedValue(new Error("hub unreachable"));
  await tapSync();
  for (let i = 0; i < 8; i++) await advance(250);
  expect(status()).toBe("error");
  client.getDocIndex.mockResolvedValue({ indexed: true, page_count: 1, embed_state: "full" });
  await advance(5_000);
  await advance(250);
  expect(status()).toBe("indexed");
});

it("stops asking the hub again after a few tries", async () => {
  const client = mocks.shell.client as unknown as { getDocIndex: ReturnType<typeof vi.fn> };
  await mount();
  client.getDocIndex.mockRejectedValue(new Error("hub unreachable"));
  await tapSync();
  for (let i = 0; i < 8; i++) await advance(250);
  const calls = client.getDocIndex.mock.calls.length;
  await advance(5_000 + 15_000 + 30_000 + 60_000 + 120_000 + 1_000);
  expect(client.getDocIndex.mock.calls.length).toBe(calls + 5);
  await advance(600_000);
  expect(client.getDocIndex.mock.calls.length).toBe(calls + 5);
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
