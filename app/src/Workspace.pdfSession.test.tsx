/** @vitest-environment jsdom */
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { Workspace } from "./Workspace";
import type { ShellValue, WorkspaceApi } from "./shellContext";
import type { BoardHandle } from "./canvas/BoardHandle";
import type { Board } from "./canvas/Board";
import type { AnnotateDoc } from "./util/annotateStore";
import type { TabRecord } from "./util/tabs";
import { loadReadingPage, saveReadingPage } from "./util/readingPosition";
import { layoutPdfPages, pdfStackFrames, PAGE_GAP, PDF_DOC_PAD_TOP } from "./modes/PdfDocument";
import {
  loadPdfFilmPref, loadPdfSpreadPref, peekPdfFilmCurrent, peekPdfLayoutBusy,
  peekPdfReadingFrames, publishPdfFilmCurrent, publishPdfFilmPredicted,
  resetPdfFilmScopes, resetPdfThumbs, setPdfPageSizes, setPdfReadingFrames,
  subscribePdfFilmPredicted, PDF_LAYOUT_BUSY_MIN_MS,
} from "./modes/pdfFilm";

type PdfProps = ComponentProps<typeof import("./modes/PdfDocument").PdfDocument>;
const mocks = vi.hoisted(() => ({
  shell: {} as ShellValue, api: null as WorkspaceApi | null,
  board: {} as BoardHandle, pdf: null as PdfProps | null,
  existing: null as AnnotateDoc | null, renderThumb: vi.fn(),
  autoLayout: true, laidOut: true, marks: [] as NonNullable<AnnotateDoc["footnotes"]>,
}));

// Keep Workspace's real loader, strip, preference writes, remapping and
// subscriptions. Canvas/decoder/layout are jsdom boundaries; no PDF is painted.
vi.mock("./shellContext", () => ({ useShell: () => mocks.shell }));
vi.mock("./canvas/boardChunk", async () => {
  const { useImperativeHandle } = await import("react");
  const BoardView = ({ ref, pageContent, pageFilm, pageSpread }: ComponentProps<typeof Board>) => {
    useImperativeHandle(ref, () => mocks.board, []);
    return <section>
      {pageFilm && <button aria-label="Toggle page strip" aria-pressed={pageFilm.open} onClick={pageFilm.onToggle} />}
      {pageSpread && <button aria-label="Toggle spread" aria-pressed={pageSpread.on} aria-busy={pageSpread.busy} onClick={pageSpread.onToggle} />}
      {pageContent}
    </section>;
  };
  return { peekBoardComponent: () => BoardView };
});
vi.mock("./modes/PdfDocument", async original => {
  const actual = await original<typeof import("./modes/PdfDocument")>();
  const { useEffect } = await import("react");
  return { ...actual, loadPdfJs: async () => ({}), PdfDocument: (props: PdfProps) => {
    mocks.pdf = props;
    useEffect(() => {
      props.onNav?.({ count: 3, current: props.initialPage || 1, aspects: [1, 1, 1] });
      props.onThumbRenderer?.(mocks.renderThumb);
      return () => { props.onNav?.(null); props.onThumbRenderer?.(null); };
    }, [props.onNav, props.onThumbRenderer]);
    useEffect(() => {
      props.onMeasure?.(4000);
      if (mocks.autoLayout) publishLayout(props.spread ?? false);
    }, [props.spread, props.frameWidth]);
    return <div data-testid="pdf" data-initial-page={props.initialPage ?? 0} data-spread={String(props.spread)} />;
  } };
});
vi.mock("./modes/DocSelectionLayer", () => ({
  DocSelectionLayer: ({ children, footnotes }: ComponentProps<typeof import("./modes/DocSelectionLayer").DocSelectionLayer>) => {
    mocks.marks = [...footnotes ?? []];
    return children;
  },
}));
vi.mock("./components/LoadingDoodle", () => ({ LoadingDoodle: () => null }));
vi.mock("./canvas/pageTurn/PageTurn", () => ({ PageTurn: () => null }));
vi.mock("./util/bootSettled", () => ({ afterBootSettled: () => new Promise(() => {}) }));
vi.mock("./util/loadingDoodleActivity", () => ({ isLoadingDoodleActive: () => false, waitForLoadingDoodleIdle: async () => {} }));
vi.mock("./util/annotateLaidOut", () => ({
  waitForAnnotateLaidOut: () => mocks.laidOut ? Promise.resolve(true) : new Promise(() => {}),
  waitForPdfPageNode: async () => true, waitForPdfPagePainted: async () => true,
}));
vi.mock("./util/annotateStore", async original => ({
  ...await original<typeof import("./util/annotateStore")>(),
  listAnnotateDocs: () => [], migrateAnnotateKeysToId: async () => {},
  getAnnotateDoc: async () => mocks.existing, listAnnotateDocsByHash: () => [], findStaleAnnotateDoc: () => null,
}));
vi.mock("./util/docBytes", async original => ({
  ...await original<typeof import("./util/docBytes")>(),
  loadBinaryDocBytesWithRetry: async () => new ArrayBuffer(8), bytesCameFromStore: () => true,
}));
vi.mock("./util/whiteboardStore", async original => ({
  ...await original<typeof import("./util/whiteboardStore")>(), listWhiteboardNotebooks: () => [],
}));
vi.mock("./util/contentStore", async original => ({
  ...await original<typeof import("./util/contentStore")>(), repairContentStore: async () => ({ promoted: 0, remaining: 0 }),
}));

const tab: TabRecord = { id: "pdf", kind: "annotate", title: "Book.pdf", docId: "saved-pdf", hash: "pdf-hash", source: "", docType: "pdf", dirty: false, lastActive: 0, indexed: "idle" };
const sizes = [1, 2, 3].map(pageNumber => ({ pageNumber, width: 600, height: 800 }));
let root: Root;
let host: HTMLDivElement;
let mounted = false;

function publishLayout(spread: boolean) {
  setPdfPageSizes(tab.id, sizes);
  setPdfReadingFrames(tab.id, pdfStackFrames(layoutPdfPages(sizes, mocks.pdf!.frameWidth ?? 1100, spread), spread, PAGE_GAP, PDF_DOC_PAD_TOP));
}
function Shell({ showing = true, active = true }: { showing?: boolean; active?: boolean }) {
  const [pdfFilmOpen, setPdfFilmOpen] = useState(loadPdfFilmPref);
  mocks.shell.pdfFilmOpen = pdfFilmOpen;
  mocks.shell.setPdfFilmOpen = setPdfFilmOpen;
  // The mock shell has no React provider; changing this callback lets memoized
  // Workspace observe the shell's new value just as a real context update does.
  return <Workspace tab={tab} active={active} showing={showing} onPracticeRequestHandled={() => {}} />;
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function mount() {
  mounted = true;
  await act(async () => { root.render(<Shell />); });
  await act(async () => { await vi.dynamicImportSettled(); });
  // Let fake IDB's task queue deliver ink reads, then finish the loader's rAF/reland waits.
  for (let i = 0; i < 8; i++) await advance(250);
  expect(mocks.pdf, JSON.stringify(vi.mocked(mocks.shell.setError).mock.calls)).toBeTruthy();
  expect(mocks.shell.setError).not.toHaveBeenCalledWith(expect.any(String));
}
function button(label: string) {
  const result = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  expect(result, label).toBeTruthy(); return result!;
}
async function click(label: string) { await act(async () => { button(label).click(); }); }
function spread() { return button("Toggle spread").getAttribute("aria-pressed") === "true"; }
function busy() { return button("Toggle spread").getAttribute("aria-busy") === "true"; }
function strip() { return document.querySelector('[aria-label="PDF pages"]'); }
function clearBoardCalls() {
  vi.mocked(mocks.board.aimPdfPage).mockClear();
  vi.mocked(mocks.board.scrollToPdfPage).mockClear();
  vi.mocked(mocks.board.remapPdfInkAcrossPdfLayout).mockClear();
  vi.mocked(mocks.board.setInkSpread).mockClear();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  localStorage.clear(); resetPdfFilmScopes(); resetPdfThumbs(); vi.clearAllMocks();
  mocks.autoLayout = true; mocks.laidOut = true; mocks.pdf = null; mocks.api = null; mocks.marks = [];
  mocks.renderThumb.mockReset().mockImplementation(async (page: number) => `data:image/jpeg;base64,page${page}`);
  mocks.existing = { id: "saved-pdf", name: "Book.pdf", hash: "pdf-hash", docType: "pdf", source: "", updatedAt: 1,
    board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } },
    footnotes: [{ id: "note", kind: "note", anchor: { kind: "region", scope: "p1", x: 20, y: 30, w: 40, h: 50 }, excerpt: "", createdAt: 1, updatedAt: 1 }],
  } as AnnotateDoc;
  const noop = () => vi.fn();
  mocks.board = {
    getElements: vi.fn(() => []), getInkStrokes: vi.fn(() => []), getInkOps: vi.fn(() => []),
    hasRasterInk: vi.fn(() => false), isPdfInkLayoutPending: vi.fn(() => false), isInking: vi.fn(() => false),
    remapPdfInkAcrossPdfLayout: vi.fn(() => true), scrollToPdfPage: vi.fn(() => true), aimPdfPage: noop(),
    setInkSpread: noop(), restoreBoard: noop(), setElements: noop(), applyThemeInk: noop(), stripCoachViz: noop(),
    waitForTemplate: vi.fn(async () => {}), settleFitView: vi.fn(async () => {}), restoreView: noop(),
    primeInkSnap: vi.fn(async () => {}), syncDocumentScrollBounds: noop(), armReadingScroll: noop(), fitCodeToSource: noop(),
    getInkOpCount: vi.fn(() => 0), getInkRevision: vi.fn(() => 0),
    inkFingerprint: vi.fn(() => "ink"), seedTemplate: noop(), setInkDoc: noop(), setInkOps: noop(),
  } as unknown as BoardHandle;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const chrome = document.createElement("div"); const agentPanel = document.createElement("div"); document.body.append(chrome, agentPanel);
  mocks.shell = {
    client: { putAgentSession: vi.fn(async () => {}) },
    mobile: false, serverLinkRef: { current: "online" }, themeId: "paper", readingSize: "M", autosaveMs: 0,
    testForward: "off", recognizer: null, capabilities: null, coachFlags: {}, llmLink: "offline", error: null,
    browseMotion: "idle", holdBrowseOverlay: false, session: { started_at: 0, active_list: null, queue: [], problems: {}, reveals: {} },
    navigateBySession: false, bankFilters: {}, tabsRef: { current: { tabs: [tab], activeId: tab.id, groups: [] } },
    headerSlots: { left: null, center: null, right: null, chrome, boardChrome: null, agentPanel },
    setThemeId: noop(), setAutosaveMs: noop(), setTestForward: noop(), setSettingsOpen: noop(), setNotice: noop(),
    setError: noop(), announceAutosave: noop(), setBrowseMotion: noop(), setHoldBrowseOverlay: noop(), setSession: noop(),
    refreshSession: vi.fn(async () => {}), setNavigateBySession: noop(), setBankFilters: noop(), openWorkspace: noop(),
    focusTab: noop(), openPracticePicker: noop(), closeTab: noop(), splitTabs: noop(), patchTab: noop(), webPush: noop(), webStep: noop(),
    setChrome: noop(), setWorkspaceApi: vi.fn((_id, api) => { mocks.api = api; }), setShellLoadActive: noop(),
    shellLoadActive: false, takeUserLoad: vi.fn(() => false), onMissingContent: noop(),
  } as unknown as ShellValue;
});
afterEach(() => {
  if (mounted) act(() => { root.unmount(); });
  mounted = false; document.body.textContent = ""; resetPdfFilmScopes(); resetPdfThumbs();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("toggles spread on and off, holds busy until layout/remap, rejects a double tap, and keeps the reading page and marks", async () => {
  await mount(); clearBoardCalls();
  const originalMark = structuredClone(mocks.marks[0]);
  act(() => { publishPdfFilmCurrent(tab.id, 2); });
  mocks.autoLayout = false;
  const from = peekPdfReadingFrames(tab.id);
  button("Toggle spread").focus();
  await click("Toggle spread");
  expect(spread()).toBe(true); expect(busy()).toBe(true); expect(peekPdfLayoutBusy(tab.id)).toBe(true);
  expect(document.activeElement).not.toBe(button("Toggle spread"));
  expect(loadPdfSpreadPref("pdf-hash")).toBe(true); expect(strip()).toBeNull(); expect(loadPdfFilmPref()).toBe(true);
  await click("Toggle spread");
  expect(spread()).toBe(true); expect(mocks.board.setInkSpread).toHaveBeenCalledTimes(1);
  await advance(64);
  expect(busy()).toBe(true); expect(mocks.board.remapPdfInkAcrossPdfLayout).not.toHaveBeenCalled();
  publishLayout(true);
  await advance(32);
  expect(mocks.board.remapPdfInkAcrossPdfLayout).toHaveBeenCalledTimes(1);
  expect(mocks.board.remapPdfInkAcrossPdfLayout).toHaveBeenCalledWith(from);
  expect(mocks.board.aimPdfPage).toHaveBeenLastCalledWith(2, { hold: false });
  expect(mocks.board.scrollToPdfPage).toHaveBeenLastCalledWith(2, { hold: false });
  const sy = (peekPdfReadingFrames(tab.id)[0]!.maxY - peekPdfReadingFrames(tab.id)[0]!.minY) / (from[0]!.maxY - from[0]!.minY);
  expect(mocks.marks[0]!.anchor).toEqual({ ...originalMark!.anchor, x: 40, y: 30 * sy, w: 80, h: 50 * sy });
  expect(busy()).toBe(true);
  await advance(PDF_LAYOUT_BUSY_MIN_MS);
  expect(busy()).toBe(false);
  mocks.autoLayout = true;
  await click("Toggle spread"); expect(spread()).toBe(false); expect(busy()).toBe(true);
  await advance(200);
  expect(loadPdfSpreadPref("pdf-hash")).toBe(false); expect(busy()).toBe(false);
  expect(mocks.board.setInkSpread).toHaveBeenLastCalledWith(true);
  expect(mocks.marks[0]).toEqual(originalMark); expect(peekPdfFilmCurrent(tab.id)).toBe(2);
});

it("ignores spread while ink layout is pending and clears busy without changing the preference when frames are missing", async () => {
  await mount(); clearBoardCalls();
  vi.mocked(mocks.board.isPdfInkLayoutPending).mockReturnValue(true);
  await click("Toggle spread"); expect(spread()).toBe(false); expect(busy()).toBe(false);
  vi.mocked(mocks.board.isPdfInkLayoutPending).mockReturnValue(false);
  setPdfReadingFrames(tab.id, []);
  await click("Toggle spread"); expect(busy()).toBe(true);
  await advance(200);
  expect(spread()).toBe(false); expect(busy()).toBe(false); expect(strip()).toBeTruthy();
  expect(mocks.board.setInkSpread).not.toHaveBeenCalled(); expect(localStorage.getItem("whiteboard.pdfSpread.pdf-hash")).toBeNull();
});

it("retries a pending remap, and a newer load cancels the old spread run", async () => {
  await mount(); clearBoardCalls();
  vi.mocked(mocks.board.remapPdfInkAcrossPdfLayout).mockReturnValue(false);
  await click("Toggle spread"); publishLayout(true); await advance(64);
  expect(busy()).toBe(true); expect(mocks.board.remapPdfInkAcrossPdfLayout).toHaveBeenCalled();
  vi.mocked(mocks.board.remapPdfInkAcrossPdfLayout).mockReturnValue(true);
  await advance(200); expect(busy()).toBe(false);
  clearBoardCalls(); mocks.autoLayout = false;
  await click("Toggle spread");
  await act(async () => { void mocks.api!.abortLoad(); });
  publishLayout(false); await advance(8500);
  expect(mocks.board.remapPdfInkAcrossPdfLayout).not.toHaveBeenCalled(); expect(busy()).toBe(false);
});

it("times out a missing target layout, reconciles the source stamp and attempts the final page scroll", async () => {
  await mount(); clearBoardCalls(); mocks.autoLayout = false;
  act(() => { publishPdfFilmCurrent(tab.id, 2); });
  await click("Toggle spread"); await advance(8200);
  expect(busy()).toBe(false); expect(spread()).toBe(true); expect(loadPdfSpreadPref("pdf-hash")).toBe(true);
  expect(mocks.board.remapPdfInkAcrossPdfLayout).not.toHaveBeenCalled();
  expect(mocks.board.setInkSpread).toHaveBeenLastCalledWith(null);
  expect(mocks.board.scrollToPdfPage).toHaveBeenLastCalledWith(2, { hold: false });
});

it("reconciles ink and mark coordinates saved in the other spread layout after opening", async () => {
  Object.assign(mocks.existing!.board.appState, { pdfSpread: true });
  await mount();
  expect(spread()).toBe(false);
  const calls = vi.mocked(mocks.board.remapPdfInkAcrossPdfLayout).mock.calls;
  expect(calls).toHaveLength(1); expect(calls[0]![0]).toHaveLength(6);
  expect(mocks.marks[0]!.anchor).toMatchObject({ kind: "region", scope: "p1", x: 10, w: 20 });
  expect(mocks.board.setInkSpread).toHaveBeenLastCalledWith(null);
});

it("toggles the page strip with its saved preference and a page jump closes it without saving closed", async () => {
  await mount(); clearBoardCalls(); expect(strip()).toBeTruthy();
  await click("Toggle page strip"); expect(strip()).toBeNull(); expect(loadPdfFilmPref()).toBe(false);
  await click("Toggle page strip"); expect(strip()).toBeTruthy(); expect(loadPdfFilmPref()).toBe(true);
  let predicted = 0; const unsubscribe = subscribePdfFilmPredicted(tab.id, page => { predicted = page; });
  act(() => { publishPdfFilmPredicted(tab.id, 3); }); expect(predicted).toBe(3);
  await click("Page 3"); expect(predicted).toBe(0); expect(strip()).toBeNull(); expect(loadPdfFilmPref()).toBe(true);
  expect(mocks.board.aimPdfPage).toHaveBeenCalledTimes(1); expect(mocks.board.aimPdfPage).toHaveBeenCalledWith(3);
  expect(mocks.board.scrollToPdfPage).toHaveBeenCalledTimes(1); expect(mocks.board.scrollToPdfPage).toHaveBeenCalledWith(3);
  unsubscribe();
});

it("honors a saved closed strip and saved spread on open", async () => {
  localStorage.setItem("whiteboard.pdfFilm", "0"); localStorage.setItem("whiteboard.pdfSpread.pdf-hash", "1");
  await mount(); expect(strip()).toBeNull(); expect(spread()).toBe(true);
  await click("Toggle page strip"); expect(strip()).toBeTruthy(); expect(loadPdfFilmPref()).toBe(true);
});

it("requests strip thumbnails through the registered renderer, then handles renderer removal and replacement", async () => {
  await mount();
  expect(mocks.renderThumb.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
  expect(document.querySelector('[aria-label="Page 2"] img')?.getAttribute("src")).toBe("data:image/jpeg;base64,page2");
  await click("Toggle page strip"); act(() => { resetPdfThumbs(); }); mocks.renderThumb.mockClear();
  await act(async () => { mocks.pdf!.onThumbRenderer?.(null); });
  await click("Toggle page strip"); await advance(1);
  expect(mocks.renderThumb).not.toHaveBeenCalled(); expect(document.querySelector('[aria-label="Page 2"] img')).toBeNull();
  const replacement = vi.fn(async (page: number) => `replacement-${page}`);
  await act(async () => { mocks.pdf!.onThumbRenderer?.(replacement); }); await advance(1);
  expect(replacement.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
  expect(document.querySelector('[aria-label="Page 3"] img')?.getAttribute("src")).toBe("replacement-3");
});

it.each(["recent", "saved", "invalid"] as const)("restores the %s reading page before decoding and aiming the camera", async kind => {
  mocks.existing!.board.appState = { scrollX: 0, scrollY: 0, zoom: 1, pdfPage: kind === "invalid" ? -4 : 2 };
  if (kind !== "invalid") {
    saveReadingPage("saved-pdf", 3);
    if (kind === "saved") mocks.existing!.updatedAt = Date.now() + 1;
  }
  await mount();
  const page = kind === "recent" ? 3 : kind === "saved" ? 2 : 0;
  expect(mocks.pdf!.initialPage ?? 0).toBe(page);
  if (page) {
    expect(mocks.board.aimPdfPage).toHaveBeenCalledWith(page);
    expect(mocks.board.restoreView).toHaveBeenCalledWith({ scrollX: 0, scrollY: 0, zoom: 1, pdfPage: page });
    expect(peekPdfFilmCurrent(tab.id)).toBe(page);
  } else expect(mocks.board.settleFitView).toHaveBeenCalled();
});

it("debounces settled reading pages by 700ms, keeps scope while parked, and cancels the pending save on close", async () => {
  await mount();
  act(() => { publishPdfFilmCurrent(tab.id, 2); }); await advance(699);
  expect(loadReadingPage("saved-pdf")).not.toBe(2);
  act(() => { publishPdfFilmCurrent(tab.id, 3); }); await advance(699);
  expect(loadReadingPage("saved-pdf")).not.toBe(3);
  await advance(1); expect(loadReadingPage("saved-pdf")).toBe(3);
  await act(async () => { root.render(<Shell showing={false} active={false} />); });
  expect(peekPdfFilmCurrent(tab.id)).toBe(3); expect(peekPdfReadingFrames(tab.id)).toHaveLength(3);
  act(() => { publishPdfFilmCurrent(tab.id, 2); });
  await act(async () => { root.unmount(); }); mounted = false;
  await advance(1000);
  expect(loadReadingPage("saved-pdf")).toBe(3); expect(peekPdfFilmCurrent(tab.id)).toBe(1); expect(peekPdfReadingFrames(tab.id)).toEqual([]);
});

it("does not persist transient reading pages while the document is still opening", async () => {
  mocks.laidOut = false;
  await mount(); act(() => { publishPdfFilmCurrent(tab.id, 2); }); await advance(1000);
  expect(loadReadingPage("saved-pdf")).toBe(0);
});
