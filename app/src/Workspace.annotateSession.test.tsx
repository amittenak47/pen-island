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
import { clearDocSource, getDocSource, setDocSource } from "./util/docSourceStore";
import { HOLD_FILL_MS } from "./util/gesture";
import type { DocSourceLiveCapture } from "./util/docSourceUpdate";
import { encodeInkOps } from "./canvas/inkCodec";

type PaperProps = ComponentProps<typeof import("./modes/AnnotateDocument").AnnotateDocument>;
type SelectionProps = ComponentProps<typeof import("./modes/DocSelectionLayer").DocSelectionLayer>;
const mocks = vi.hoisted(() => ({
  shell: {} as ShellValue, api: null as WorkspaceApi | null, board: {} as BoardHandle,
  paper: null as PaperProps | null, boardProps: null as ComponentProps<typeof Board> | null,
  selection: null as SelectionProps | null,
  agent: null as ComponentProps<typeof import("./modes/AgentSidePanel").AgentSidePanel> | null,
  marks: [] as DocFootnote[], docs: new Map<string, AnnotateDoc>(),
  height: 2400, save: vi.fn(), restore: vi.fn(), remove: vi.fn(), snapshots: vi.fn(),
  sourceCheck: vi.fn(), sourceUpdate: vi.fn(), sourceLink: vi.fn(), sourceJustLink: vi.fn(), sourceUnlink: vi.fn(), pickSource: vi.fn(), pick: vi.fn(),
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
    mocks.selection = props;
    mocks.marks = [...props.footnotes ?? []];
    return <>
      {props.children}
      {props.footnotes?.map(mark => <button key={mark.id} onClick={() => props.onOpenFootnote?.(mark, null)}>Open {mark.id}</button>)}
    </>;
  },
}));
vi.mock("./modes/AgentSidePanel", async original => ({
  ...await original<typeof import("./modes/AgentSidePanel")>(),
  AgentSidePanel: (props: ComponentProps<typeof import("./modes/AgentSidePanel").AgentSidePanel>) => {
    mocks.agent = props;
    return null;
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
vi.mock("./util/docSourceUpdate", () => ({
  DOC_SOURCE_CHECKED_EVENT: "lc-doc-source-checked", DOC_SOURCE_UPDATING_EVENT: "lc-doc-source-updating", DOC_SOURCE_UPDATED_EVENT: "lc-doc-source-updated",
  checkDocSource: (...args: unknown[]) => mocks.sourceCheck(...args),
  updateDocFromSource: (...args: unknown[]) => mocks.sourceUpdate(...args),
  linkDocSource: (...args: unknown[]) => mocks.sourceLink(...args),
  justLinkDocSource: (...args: unknown[]) => mocks.sourceJustLink(...args),
  unlinkDocSource: (...args: unknown[]) => mocks.sourceUnlink(...args),
}));
vi.mock("./util/docSourceNative", async original => ({
  ...await original<typeof import("./util/docSourceNative")>(), nativeSourcePickerAvailable: () => true,
  pickDocumentSource: () => mocks.pickSource(),
}));
vi.mock("./util/annotateFs", async original => ({
  ...await original<typeof import("./util/annotateFs")>(), pickDocumentFile: () => mocks.pick(),
}));
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
  mocks.sourceCheck.mockReset().mockResolvedValue({ status: "same" });
  mocks.sourceUpdate.mockReset().mockResolvedValue({ unplaced: [] });
  mocks.sourceLink.mockReset().mockResolvedValue({ status: "linked" });
  mocks.sourceJustLink.mockReset().mockImplementation((id, ref) => setDocSource(id, { ...ref, hash: mocks.docs.get(id)!.hash, checkedAt: 0 }));
  mocks.sourceUnlink.mockReset().mockImplementation(clearDocSource);
  mocks.pickSource.mockReset().mockResolvedValue(null);
  mocks.pick.mockReset().mockResolvedValue(null);
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
    snapshotInkPages: vi.fn(() => new Map()),
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

it.each(["annotate", "mark"])("saves explicit empty lists on a new %s footnote", async action => {
  await mount();
  if (action === "mark") await act(async () => { mocks.boardProps!.onHighlightingChange!(true); });
  const selection = { text: "First", excerpt: "First", anchor: { kind: "text" as const, start: 2, end: 7 }, hitRects: [] };
  await act(async () => {
    if (action === "annotate") mocks.selection!.onAnnotate!(selection, null);
    else mocks.selection!.onMark!(selection, null);
  });
  await click(saveLabel);
  const saved = mocks.save.mock.calls.at(-1)![0].footnotes.find((mark: DocFootnote) => mark.anchor.kind === "text");
  expect(saved).toMatchObject({ notes: [], threads: [], bands: [], subMarks: [], userLinks: [], whiteboards: [], artifacts: [] });
});

it.each([false, true])("saves message defaults and proposal list defaults (proposal: %s)", async hasProposal => {
  const ask = vi.fn(async () => ({ reply: "An answer", programs: [], artifacts: hasProposal ? [{ kind: "code", title: "answer.py", source: "print(1)" }] : [] }));
  Object.assign(mocks.shell.client, { runPreparedCoach: ask });
  await mount();
  act(() => { void mocks.agent!.onSend("A question", {
    ask: true, draw: false, reviewBoard: false, lazy: false, handwriting: false,
    capture: false, annotations: false, reasoning: "off",
  }); });
  for (let i = 0; i < 30 && !mocks.agent!.messages.some(message => message.content === "An answer"); i++) await advance(100);
  expect(mocks.shell.setError).not.toHaveBeenCalledWith(expect.any(String));
  expect(ask).toHaveBeenCalledTimes(1);
  await click(saveLabel);
  const messages = mocks.save.mock.calls.at(-1)![0].agent;
  expect(messages).toHaveLength(2);
  for (const message of messages) expect(message).toMatchObject({ attachments: [], artifacts: [], processEvents: [], pending: false, queued: false, bridgePending: false });
  expect(messages[0].artifactProposals).toEqual([]);
  expect(messages[1].artifactProposals).toEqual(hasProposal ? [{ kind: "code", title: "answer.py", source: "print(1)", programs: [], messages: [] }] : []);
  expect(messages[1].flags).toEqual(["Ask"]);
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

const linkedLabel = "Linked to “First.md”. Tap to check for a newer version, hold for more.";
const unlinkedLabel = "Not linked. Tap to link the file this came from.";
/** The Link half of the Annotate menu's [Sync | Link]. The menu opens on a hold of the header icon. */
async function linkHalf() {
  if (!document.querySelector(".lc-sync-link-link")) {
    const menu = button("Markdown documents: tap to save now, hold for save / open menu");
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await advance(HOLD_FILL_MS + 50);
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })); });
    await advance(400);
  }
  const found = document.querySelector<HTMLButtonElement>(".lc-sync-link-link");
  expect(found, "Link half").toBeTruthy(); return found!;
}
async function clickLink() { const link = await linkHalf(); await act(async () => { link.click(); }); }
const sourceRef = { kind: "path" as const, location: "/First.md", name: "First.md", size: 7, modified: 1, hash: hashMarkdown("# First"), checkedAt: 1 };

it("checks a source on demand, shows work while checking, and reports same and missing copies", async () => {
  setDocSource("first", sourceRef);
  await mount();
  const checked = deferred<{ status: "same" }>(); mocks.sourceCheck.mockReturnValueOnce(checked.promise);
  await clickLink();
  expect(mocks.sourceCheck).toHaveBeenCalledWith("first");
  expect((await linkHalf()).getAttribute("aria-busy")).toBe("true");
  expect((await linkHalf()).querySelector(".lc-doc-index-ring")).not.toBeNull();
  await act(async () => { checked.resolve({ status: "same" }); });
  expect(mocks.shell.setNotice).toHaveBeenCalledWith("Up to date");
  mocks.sourceCheck.mockResolvedValueOnce({ status: "missing" }); await clickLink();
  expect(document.querySelector('[role="dialog"][aria-label="Linked file not found"]')).not.toBeNull();
  expect(document.body.textContent).toContain("“First.md” isn't where it was. Find it to keep this document up to date.");
  await click("Find the file…");
  expect(mocks.pickSource).toHaveBeenCalledOnce();
  expect(mocks.sourceLink).not.toHaveBeenCalled();
});

it("links an existing document from the menu's Link and keeps picker cancellation quiet", async () => {
  await mount();
  await clickLink();
  expect(mocks.sourceLink).not.toHaveBeenCalled();
  mocks.pickSource.mockResolvedValue(sourceRef);
  mocks.sourceLink.mockImplementation(async (id, pick) => { setDocSource(id, pick); return { status: "linked" }; });
  await clickLink();
  expect(mocks.sourceLink).toHaveBeenCalledWith("first", sourceRef);
  expect(mocks.shell.setNotice).toHaveBeenCalledWith("Linked to “First.md”.");
  expect((await linkHalf()).getAttribute("aria-label")).toBe(linkedLabel);
});

it("offers differing files with Cancel, Just link, and a held update", async () => {
  await mount();
  const content = { status: "newer", text: "# Different", ref: { ...sourceRef, hash: hashMarkdown("# Different") } };
  mocks.pickSource.mockResolvedValue(sourceRef);
  mocks.sourceLink.mockResolvedValue({ status: "differs", content });
  await clickLink();
  expect(document.querySelector('[role="dialog"][aria-label="This file is different"]')).not.toBeNull();
  expect(document.body.textContent).toContain("“First.md” doesn't match the app's copy of “First.md”.");
  await click("Cancel");
  expect(getDocSource("first")).toBeNull();
  await clickLink(); await click("Just link");
  expect(mocks.sourceJustLink).toHaveBeenCalledWith("first", content.ref);
  expect(getDocSource("first")?.hash).toBe(mocks.docs.get("first")!.hash);
  expect(mocks.sourceUpdate).not.toHaveBeenCalled();
  const trigger = await linkHalf();
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await advance(HOLD_FILL_MS + 50);
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })); });
  await click("Link to a different file…");
  await click("Hold to confirm: Update to this file");
  expect(mocks.sourceUpdate).not.toHaveBeenCalled();
  const update = button("Hold to confirm: Update to this file");
  await act(async () => { update.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await advance(HOLD_FILL_MS + 50);
  await act(async () => { update.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })); });
  expect(mocks.sourceUpdate).toHaveBeenCalledWith("first", content);
});

it("unlinks immediately from Link's hold menu", async () => {
  setDocSource("first", sourceRef); await mount();
  const trigger = await linkHalf();
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await advance(HOLD_FILL_MS + 50);
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })); });
  await click("Unlink");
  expect(getDocSource("first")).toBeNull();
  expect((await linkHalf()).getAttribute("aria-label")).toBe(unlinkedLabel);
  expect(mocks.shell.setNotice).toHaveBeenCalledWith("Unlinked. The app's copy stays.");
  expect(mocks.docs.get("first")!.source).toBe("# First");
});

it("keeps the newer dot after Not now and updates the same open tab before its success notice", async () => {
  setDocSource("first", sourceRef);
  const content = { status: "newer", text: "# Revised", ref: { ...sourceRef, hash: hashMarkdown("# Revised"), size: 9, modified: 2 } };
  mocks.sourceCheck.mockResolvedValue(content);
  await mount(); await clickLink();
  expect(document.querySelector('[role="dialog"][aria-label="Newer version available"]')).not.toBeNull();
  expect(document.body.textContent).toContain("“First.md” has changed on this device since you opened it.");
  await click("Not now");
  expect((await linkHalf()).querySelector(".lc-library-sync-dot")).not.toBeNull();
  expect(mocks.sourceUpdate).not.toHaveBeenCalled();
  await clickLink();
  mocks.sourceUpdate.mockImplementationOnce(async (id: string) => {
    const captures: Promise<DocSourceLiveCapture>[] = [];
    const releases: (() => void)[] = [];
    window.dispatchEvent(new CustomEvent("lc-doc-source-updating", { detail: { id, captures, releases } }));
    expect(await Promise.all(captures)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ source: "# First", footnotes: mocks.marks }) })]);
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.docs.set(id, { ...mocks.docs.get(id)!, source: content.text, hash: content.ref.hash });
    const reloads: Promise<void>[] = [];
    window.dispatchEvent(new CustomEvent("lc-doc-source-updated", { detail: { id, reloads } }));
    await Promise.all(reloads);
    for (const release of releases) release();
    return { unplaced: [{ kind: "footnote", label: "A passage" }] };
  });
  const update = button("Hold to confirm: Update");
  await act(async () => { update.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await advance(HOLD_FILL_MS + 50);
  await act(async () => { update.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })); });
  for (let i = 0; i < 12; i++) await advance(250);
  expect(mocks.sourceUpdate).toHaveBeenCalledWith("first", content);
  expect(mocks.paper!.source).toBe("# Revised");
  expect(mocks.shell.patchTab).toHaveBeenCalledWith(tab.id, expect.objectContaining({ docId: "first", hash: content.ref.hash }));
  expect(mocks.shell.setNotice).toHaveBeenCalledWith("Updated to the newer version. 1 annotations couldn't be placed and stay in the previous version (Recents → retained copies).");
  expect((await linkHalf()).querySelector(".lc-library-sync-dot")).toBeNull();
});

it("waits for the matching document to be active before presenting a completed background check", async () => {
  setDocSource("first", sourceRef);
  const checked = deferred<{ status: "newer"; text: string; ref: typeof sourceRef }>();
  mocks.sourceCheck.mockReturnValueOnce(checked.promise);
  await mount(); await clickLink();
  await act(async () => { root.render(<Workspace key={tab.id} tab={tab} active={false} showing={false} />); });
  await act(async () => { checked.resolve({ status: "newer", text: "# New", ref: sourceRef }); });
  expect(document.querySelector('[role="dialog"][aria-label="Newer version available"]')).toBeNull();
  await act(async () => { root.render(<Workspace key={tab.id} tab={tab} active showing />); });
  expect(document.querySelector('[role="dialog"][aria-label="Newer version available"]')).not.toBeNull();
  await click("Not now");
});

it("keeps a normal native pick's source on the annotation set selected by the open", async () => {
  const home: TabRecord = { id: "home", kind: "home", title: "Home", dirty: false, lastActive: 0 };
  const source = { ...sourceRef, name: "Native.md", location: "/Native.md", hash: hashMarkdown("# Native") };
  mocks.pick.mockResolvedValue({ name: source.name, docType: "markdown", text: "# Native", source });
  await mount(home);
  await click("Document pad: tap to open a file, hold for recent documents");
  for (let i = 0; i < 12 && !vi.mocked(mocks.shell.openWorkspace).mock.calls.length; i++) await advance(250);
  expect(mocks.pick).toHaveBeenCalledOnce();
  expect(mocks.shell.setError).not.toHaveBeenCalledWith(expect.any(String));
  const opened = vi.mocked(mocks.shell.openWorkspace).mock.calls.at(-1)![0];
  expect(opened).toMatchObject({ kind: "annotate", title: "Native.md", hash: source.hash });
  expect(getDocSource(opened.kind === "annotate" ? opened.docId! : "")).toEqual(source);
});

it("captures unsaved marks and ink without an authored save when a source backup fails", async () => {
  setDocSource("first", sourceRef);
  const content = { status: "newer", text: "# Revised", ref: { ...sourceRef, hash: hashMarkdown("# Revised") } };
  mocks.sourceCheck.mockResolvedValue(content);
  await mount(); await click("Open mark-first"); await click("Edit title"); await click("Close footnote");
  const original = structuredClone(mocks.docs.get("first")!);
  const ink = encodeInkOps([]);
  vi.mocked(mocks.board.snapshotInkPages).mockReturnValue(new Map([[3, ink]]));
  let captured: DocSourceLiveCapture | undefined;
  mocks.sourceUpdate.mockImplementationOnce(async (id: string) => {
    const captures: Promise<DocSourceLiveCapture>[] = [], releases: (() => void)[] = [];
    try {
      window.dispatchEvent(new CustomEvent("lc-doc-source-updating", { detail: { id, captures, releases } }));
      [captured] = await Promise.all(captures);
      throw new Error("Backup failed");
    } finally { for (const release of releases) release(); }
  });
  await clickLink();
  const update = button("Hold to confirm: Update");
  await act(async () => { update.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await advance(HOLD_FILL_MS + 50);
  await act(async () => { update.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })); });
  expect(captured).toMatchObject({ payload: { source: "# First", footnotes: [{ title: "Edited title" }] },
    pages: [{ docKey: "md:first", pageId: 3, inkC: ink }] });
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.docs.get("first")).toEqual(original);
  expect(mocks.paper!.source).toBe("# First");
  expect(mocks.marks[0]!.title).toBe("Edited title");
  expect(document.body.textContent).toContain("Backup failed");
  await click("Not now");
});

it("keeps autosave suspended when the committed newer copy cannot reload and rejects a stale retry", async () => {
  setDocSource("first", sourceRef);
  const content = { status: "newer", text: "# Revised", ref: { ...sourceRef, hash: hashMarkdown("# Revised") } };
  mocks.sourceCheck.mockResolvedValue(content);
  await mount(); await click("Open mark-first"); await click("Edit title"); await click("Close footnote");
  mocks.sourceUpdate.mockImplementationOnce(async (id: string) => {
    const captures: Promise<DocSourceLiveCapture>[] = [], releases: (() => void)[] = [];
    try {
      window.dispatchEvent(new CustomEvent("lc-doc-source-updating", { detail: { id, captures, releases } }));
      await Promise.all(captures);
      mocks.docs.set(id, { ...mocks.docs.get(id)!, source: content.text, hash: content.ref.hash });
      vi.spyOn(mocks.docs, "get").mockImplementationOnce(() => { throw new Error("Could not reopen the saved copy"); });
      const reloads: Promise<void>[] = [];
      window.dispatchEvent(new CustomEvent("lc-doc-source-updated", { detail: { id, reloads } }));
      await Promise.all(reloads);
      return { unplaced: [] };
    } finally { for (const release of releases) release(); }
  });
  await clickLink();
  const update = button("Hold to confirm: Update");
  await act(async () => { update.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await advance(HOLD_FILL_MS + 50);
  await act(async () => { update.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })); });
  expect(document.body.textContent).toContain("Could not reopen the saved copy");
  expect(mocks.shell.setNotice).not.toHaveBeenCalledWith("Updated to the newer version.");
  mocks.shell.autosaveMs = 3000;
  await act(async () => { root.render(<Workspace key={tab.id} tab={tab} active showing />); });
  await advance(4_000);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.docs.get("first")!.hash).toBe(content.ref.hash);
  expect(mocks.paper!.source).toBe("# First");
  const captures: Promise<DocSourceLiveCapture>[] = [], releases: (() => void)[] = [];
  await act(async () => {
    window.dispatchEvent(new CustomEvent("lc-doc-source-updating", { detail: { id: "first", captures, releases } }));
    await expect(Promise.all(captures)).rejects.toThrow("Reopen this document before updating it.");
    for (const release of releases) release();
  });
  await click("Not now");
});

it("writes blank block text on a selection with no text", async () => {
  await mount();
  const selection = { text: "", excerpt: "", anchor: { kind: "text" as const, start: 2, end: 7 }, hitRects: [] };
  await act(async () => { mocks.selection!.onAnnotate!(selection, null); });
  await click(saveLabel);
  const saved = mocks.save.mock.calls.at(-1)![0].footnotes.find((mark: DocFootnote) => mark.anchor.kind === "text");
  expect(saved).toHaveProperty("blockText", "");
});
