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
import { footnoteRevision, type DocFootnote } from "./util/docFootnotes";
import type { TabRecord } from "./util/tabs";
import { annotatePageHeight } from "./templates/annotate";
import { FNWB_SAVED_EVENT } from "./util/footnoteWhiteboardStore";

type PaperProps = ComponentProps<typeof import("./modes/AnnotateDocument").AnnotateDocument>;
type SelectionProps = ComponentProps<typeof import("./modes/DocSelectionLayer").DocSelectionLayer>;
const mocks = vi.hoisted(() => ({
  shell: {} as ShellValue, api: null as WorkspaceApi | null, board: {} as BoardHandle,
  paper: null as PaperProps | null, boardProps: null as ComponentProps<typeof Board> | null,
  marks: [] as DocFootnote[], docs: new Map<string, AnnotateDoc>(),
  height: 2400, save: vi.fn(), restore: vi.fn(), remove: vi.fn(), snapshots: vi.fn(),
}));

// Keep Workspace's loader, real height gate, fingerprinting, save and leave
// handlers. Canvas and text layout are jsdom boundaries: report a measurement
// through the renderer's real callback and inspect the board's page prop.
vi.mock("./shellContext", () => ({ useShell: () => mocks.shell }));
vi.mock("./canvas/boardChunk", async () => {
  const { useImperativeHandle } = await import("react");
  const BoardView = (props: ComponentProps<typeof Board>) => {
    mocks.boardProps = props;
    useImperativeHandle(props.ref, () => mocks.board, []);
    return <section data-testid="board" data-height={props.pageContentHeight}>{props.pageContent}</section>;
  };
  return { peekBoardComponent: () => BoardView };
});
vi.mock("./modes/AnnotateDocument", async () => {
  const { useEffect } = await import("react");
  return { AnnotateDocument: (props: PaperProps) => {
    mocks.paper = props;
    useEffect(() => { props.onMeasure?.(mocks.height); }, [props.source, props.onMeasure]);
    return <article>{props.source}</article>;
  } };
});
vi.mock("./modes/DocSelectionLayer", () => ({
  DocSelectionLayer: (props: SelectionProps) => {
    mocks.marks = [...props.footnotes ?? []];
    return <>
      {props.children}
      {props.footnotes?.map(mark => <button key={mark.id} onClick={() => props.onOpenFootnote?.(mark, null)}>Open {mark.id}</button>)}
    </>;
  },
}));
vi.mock("./modes/FootnoteOverview", () => ({
  FootnoteOverview: ({ footnote, onChange, onClose }: ComponentProps<typeof import("./modes/FootnoteOverview").FootnoteOverview>) =>
    <aside aria-label="Footnote editor">
      <button onClick={() => onChange({ ...footnote, title: "Edited title" })}>Edit title</button>
      <button onClick={() => onChange({ ...footnote })}>Unchanged edit</button>
      <button onClick={onClose}>Close footnote</button>
    </aside>,
}));
vi.mock("./components/LoadingDoodle", () => ({ LoadingDoodle: () => null }));
vi.mock("./canvas/pageTurn/PageTurn", () => ({ PageTurn: () => null }));
vi.mock("./util/bootSettled", () => ({ afterBootSettled: () => new Promise(() => {}) }));
vi.mock("./util/loadingDoodleActivity", () => ({ isLoadingDoodleActive: () => false, waitForLoadingDoodleIdle: async () => {} }));
vi.mock("./util/annotateStore", async original => ({
  ...await original<typeof import("./util/annotateStore")>(),
  listAnnotateDocs: () => [], migrateAnnotateKeysToId: async () => {},
  getAnnotateDoc: async (id: string) => mocks.docs.get(id) ?? null,
  getAnnotateDocMeta: (id: string) => mocks.docs.get(id) ?? null,
  findAnnotateDocByHash: async () => null, listAnnotateDocsByHash: () => [], findStaleAnnotateDoc: () => null,
  saveAnnotateDoc: (...args: unknown[]) => mocks.save(...args),
  restoreAnnotateDoc: (...args: unknown[]) => mocks.restore(...args),
  deleteAnnotateDoc: (...args: unknown[]) => mocks.remove(...args),
}));
vi.mock("./util/padSnapshotExtras", async original => ({
  ...await original<typeof import("./util/padSnapshotExtras")>(),
  recordPadSnapshotsWithExtras: (...args: unknown[]) => mocks.snapshots(...args),
}));
vi.mock("./util/whiteboardStore", async original => ({
  ...await original<typeof import("./util/whiteboardStore")>(), listWhiteboardNotebooks: () => [],
}));
vi.mock("./util/contentStore", async original => ({
  ...await original<typeof import("./util/contentStore")>(), repairContentStore: async () => ({ promoted: 0, remaining: 0 }),
}));

const tab: TabRecord = { id: "annotate", kind: "annotate", title: "First.md", docId: "first", hash: "first-hash", source: "# First", docType: "markdown", dirty: false, lastActive: 0, indexed: "idle" };
const saveLabel = "Markdown documents: tap to save now, hold for save / open menu";
let root: Root;
let mounted = false;

function doc(id = "first", title = "First", width = 620): AnnotateDoc {
  return {
    id, name: `${title}.md`, hash: hashMarkdown(`# ${title}`), source: `# ${title}`, docType: "markdown", updatedAt: 1,
    board: { v: 1, elements: [{ id: `frame-${id}`, type: "rectangle", width, customData: { lcMdInkFrame: true, lcSkeleton: true } }], appState: { scrollX: 0, scrollY: 0, zoom: 1 } },
    footnotes: [{ id: `mark-${id}`, kind: "note", anchor: { kind: "region", scope: "p1", x: 10, y: 20, w: 30, h: 40 }, excerpt: "A passage", title: "Original title", createdAt: 1, updatedAt: 1 }],
  } as AnnotateDoc;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function mount(next = tab, key = next.id) {
  mounted = true;
  mocks.shell.tabsRef.current = { tabs: [next], activeId: next.id, groups: [] };
  await act(async () => { root.render(<Workspace key={key} tab={next} active showing />); });
  await act(async () => { await vi.dynamicImportSettled(); });
  for (let i = 0; i < 12; i++) await advance(250);
  expect(mocks.shell.setError).not.toHaveBeenCalledWith(expect.any(String));
  expect(mocks.api!.isLoadActive()).toBe(false);
}
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(el => el.textContent === label || el.getAttribute("aria-label") === label);
  expect(found, label).toBeTruthy(); return found!;
}
async function click(label: string) { await act(async () => { button(label).click(); }); }
async function leave() {
  const result = vi.fn();
  await act(async () => { void mocks.api!.leave().then(result); });
  return result;
}
function leaveDialog() { return document.querySelector('[role="dialog"][aria-label="Leave document?"]'); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  localStorage.clear(); vi.clearAllMocks();
  mocks.api = null; mocks.paper = null; mocks.boardProps = null; mocks.marks = []; mocks.height = 2400;
  mocks.docs.clear(); mocks.docs.set("first", doc());
  mocks.save.mockReset().mockImplementation(async input => {
    const saved = structuredClone({ ...mocks.docs.get(input.id), ...input, id: input.id ?? "minted", updatedAt: Date.now() });
    mocks.docs.set(saved.id, saved); return saved;
  });
  mocks.restore.mockReset().mockImplementation(async saved => { mocks.docs.set(saved.id, structuredClone(saved)); });
  mocks.remove.mockReset().mockImplementation(async id => { mocks.docs.delete(id); });
  mocks.snapshots.mockReset().mockResolvedValue(undefined);
  const noop = () => vi.fn();
  mocks.board = {
    getElements: vi.fn(() => []), getInkStrokes: vi.fn(() => []), getInkOps: vi.fn(() => []),
    hasRasterInk: vi.fn(() => false), isPdfInkLayoutPending: vi.fn(() => false), isInking: vi.fn(() => false),
    restoreBoard: noop(), setElements: noop(), applyThemeInk: noop(), stripCoachViz: noop(),
    waitForTemplate: vi.fn(async () => {}), settleFitView: vi.fn(async () => {}), restoreView: noop(),
    primeInkSnap: vi.fn(async () => {}), syncDocumentScrollBounds: noop(), armReadingScroll: noop(), fitCodeToSource: noop(),
    getInkOpCount: vi.fn(() => 0), getInkRevision: vi.fn(() => 0), dirtyInkPageCount: vi.fn(() => 0),
    takeDirtyInkPages: vi.fn(() => new Map()), markInkPagesFlushed: noop(),
    inkFingerprint: vi.fn(() => "ink"), seedTemplate: noop(), setInkDoc: noop(), setInkOps: noop(), setInkSpread: noop(),
    saveBoard: vi.fn(() => ({ v: 1, elements: [], appState: {} })),
  } as unknown as BoardHandle;
  const host = document.createElement("div"); const chrome = document.createElement("div"); const agentPanel = document.createElement("div");
  document.body.append(host, chrome, agentPanel); root = createRoot(host);
  mocks.shell = {
    client: { putAgentSession: vi.fn(async () => {}) },
    mobile: false, serverLinkRef: { current: "online" }, themeId: "paper", readingSize: "M", autosaveMs: 0,
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

it("opens markdown with its marks and saved width, reports height to the page, and ignores subpixel state changes", async () => {
  await mount();
  expect(mocks.paper!.source).toBe("# First");
  expect(mocks.boardProps!.pageContentHeight).toBe(annotatePageHeight(2400));
  expect(mocks.marks).toEqual(doc().footnotes);
  expect(mocks.board.restoreBoard).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ skeletons: expect.arrayContaining([expect.objectContaining({ width: 620 })]) }));
  expect(mocks.shell.patchTab).toHaveBeenCalledWith(tab.id, { docId: "first", source: null });
  await act(async () => { mocks.paper!.onMeasure?.(2400.5); });
  expect(mocks.boardProps!.pageContentHeight).toBe(annotatePageHeight(2400));
  await act(async () => { mocks.paper!.onMeasure?.(3200); });
  expect(mocks.boardProps!.pageContentHeight).toBe(annotatePageHeight(3200));
  expect(mocks.save).not.toHaveBeenCalled();
});

it("timestamps footnote edits, detects footnote-only dirtiness, and an explicit save makes leaving pristine", async () => {
  await mount();
  await click("Open mark-first"); await click("Unchanged edit");
  expect(mocks.marks[0]!.updatedAt).toBe(1);
  const revision = footnoteRevision(mocks.marks);
  await click("Edit title"); await click("Close footnote");
  expect(mocks.marks[0]).toMatchObject({ title: "Edited title", updatedAt: Date.now() });
  expect(footnoteRevision(mocks.marks)).not.toBe(revision);
  const pending = await leave(); expect(pending).not.toHaveBeenCalled(); expect(leaveDialog()).toBeTruthy();
  await click("Cancel");
  await click(saveLabel);
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ id: "first", source: "# First", footnotes: mocks.marks, agent: [] }));
  expect(mocks.snapshots).toHaveBeenCalledWith(expect.objectContaining({ kind: "annotate", key: "first", footnotes: mocks.marks }));
  const saved = structuredClone(mocks.docs.get("first"));
  const done = await leave(); expect(done).toHaveBeenCalledWith(true); expect(leaveDialog()).toBeNull();
  expect(mocks.restore).toHaveBeenCalledWith(saved);
  expect(mocks.marks).toEqual([]);
  expect(mocks.shell.patchTab).toHaveBeenCalledWith(tab.id, { docId: null });
  // Discard clears the session identity/marks; the source and measure remain
  // mounted until the shell actually removes this Workspace.
  expect(mocks.paper!.source).toBe("# First");
  expect(mocks.boardProps!.pageContentHeight).toBe(annotatePageHeight(2400));
});

it("does not mark edits made during an in-flight save pristine, and recovers after a failed save", async () => {
  await mount();
  const stored = structuredClone(mocks.docs.get("first")!);
  const pending = deferred<AnnotateDoc>(); mocks.save.mockReturnValueOnce(pending.promise);
  await click(saveLabel);
  await click("Open mark-first"); await click("Edit title"); await click("Close footnote");
  await act(async () => { pending.resolve(stored); });
  await leave(); expect(leaveDialog()).toBeTruthy(); await click("Cancel");
  mocks.save.mockRejectedValueOnce(new Error("Save failed")); await click(saveLabel);
  expect(mocks.shell.setError).toHaveBeenCalledWith("Save failed");
  expect(mocks.marks[0]!.title).toBe("Edited title");
  await leave(); expect(leaveDialog()).toBeTruthy(); await click("Cancel");
  await click(saveLabel);
  const done = await leave(); expect(done).toHaveBeenCalledWith(true); expect(leaveDialog()).toBeNull();
});

it("leaves a read-only session without saving, restores its opening baseline, and unregisters on unmount", async () => {
  const baseline = structuredClone(mocks.docs.get("first")!);
  await mount();
  const done = await leave(); expect(done).toHaveBeenCalledWith(true); expect(leaveDialog()).toBeNull();
  expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.restore).toHaveBeenCalledWith(baseline);
  expect(mocks.marks).toEqual([]);
  await act(async () => root.unmount()); mounted = false;
  expect(mocks.api).toBeNull();
});

it("discards an unsaved session without creating a library entry or discarding its parked source", async () => {
  mocks.docs.clear();
  await mount({ ...tab, docId: null });
  expect(mocks.shell.patchTab).not.toHaveBeenCalledWith(tab.id, expect.objectContaining({ source: null }));
  const done = await leave(); expect(done).toHaveBeenCalledWith(true);
  expect(mocks.remove).toHaveBeenCalledWith(expect.any(String));
  expect(mocks.restore).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});

it("replaces the first keyed document with a clean second session, width, marks and measurement", async () => {
  await mount(); await click("Open mark-first"); await click("Edit title"); await click("Close footnote");
  await click(saveLabel);
  mocks.docs.set("second", doc("second", "Second", 480)); mocks.height = 1600;
  await mount({ ...tab, id: "annotate-second", docId: "second", title: "Second.md", source: "# Second" });
  expect(mocks.paper!.source).toBe("# Second"); expect(mocks.marks).toEqual(doc("second", "Second", 480).footnotes);
  expect(document.querySelector('[aria-label="Footnote editor"]')).toBeNull();
  expect(mocks.boardProps!.pageContentHeight).toBe(annotatePageHeight(1600));
  expect(mocks.board.restoreBoard).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ skeletons: expect.arrayContaining([expect.objectContaining({ width: 480 })]) }));
  const done = await leave(); expect(done).toHaveBeenCalledWith(true); expect(leaveDialog()).toBeNull();
  expect(mocks.restore).toHaveBeenLastCalledWith(doc("second", "Second", 480));
  expect(mocks.docs.get("first")!.footnotes![0]!.title).toBe("Edited title");
});

it("updates only the open document's footnote board timestamps when another scratch board saves", async () => {
  mocks.docs.get("first")!.footnotes![0]!.whiteboards = [{ id: "scratch", title: "Notes", createdAt: 1, updatedAt: 1 }];
  await mount();
  await act(async () => { window.dispatchEvent(new CustomEvent(FNWB_SAVED_EVENT, { detail: { docId: "other", wbId: "scratch" } })); });
  expect(mocks.marks[0]!.whiteboards![0]!.updatedAt).toBe(1);
  await act(async () => { window.dispatchEvent(new CustomEvent(FNWB_SAVED_EVENT, { detail: { docId: "first", wbId: "scratch" } })); });
  expect(mocks.marks[0]!.whiteboards![0]!.updatedAt).toBe(Date.now());
  await leave(); expect(leaveDialog()).toBeTruthy();
});
