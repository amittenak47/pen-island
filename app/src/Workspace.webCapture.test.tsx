/** @vitest-environment jsdom */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellValue, WorkspaceApi } from "./shellContext";
import type { SessionSnapshot } from "./api/types";
import type { TabRecord } from "./util/tabs";
import { Workspace } from "./Workspace";
import "fake-indexeddb/auto";
import type { AnnotateDoc } from "./util/annotateStore";
import { docIdentityHash } from "./util/annotateStore";
import { loadWebViewMode } from "./util/webViewMode";
import { setDocSource } from "./util/docSourceStore";

// Mount Workspace with its real address bar, freeze dialog and handlers.
// Native capture and canvas/layout are boundaries, not replacement handlers.
const mocks = vi.hoisted(() => ({
  native: true, existing: null as AnnotateDoc | null, fetch: vi.fn(), serialize: vi.fn(), fromHtml: vi.fn(),
  shell: {} as ShellValue,
  api: null as WorkspaceApi | null,
  reset: vi.fn(), finish: vi.fn(), reveal: vi.fn(), setWebUrl: vi.fn(),
  liveOriginal: null as string | null, openFolder: vi.fn(), grantFolder: vi.fn(), drawPage: false,
}));
// Observe the real address state setter while leaving React's state behavior intact.
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: ((initial: unknown) => {
    const [value, setValue] = react.useState(initial);
    if (initial !== "https://www.google.com/") return [value, setValue];
    return [value, (next: unknown) => { mocks.setWebUrl(next); setValue(next); }];
  }) as typeof react.useState };
});
vi.mock("./shellContext", () => ({ useShell: () => mocks.shell }));
// The board draws nothing, or only its page content when a test needs the page's own frame.
vi.mock("./canvas/boardChunk", () => ({ peekBoardComponent: () => (props: { pageContent?: import("react").ReactNode }) => mocks.drawPage ? props.pageContent ?? null : null }));
vi.mock("./components/LoadingDoodle", () => ({ LoadingDoodle: () => null }));
vi.mock("./util/bootSettled", () => ({ afterBootSettled: () => new Promise(() => {}) }));
vi.mock("./util/loadingDoodleActivity", () => ({
  isLoadingDoodleActive: () => false, waitForLoadingDoodleIdle: async () => {},
}));
vi.mock("./util/problemBoardStore", async (original) => ({
  ...await original<typeof import("./util/problemBoardStore")>(),
  getProblemBoard: async () => null,
}));
vi.mock("./util/annotateStore", async (original) => ({
  ...await original<typeof import("./util/annotateStore")>(),
  listAnnotateDocs: () => [], migrateAnnotateKeysToId: async () => {},
  getAnnotateDoc: async () => mocks.existing,
  listAnnotateDocsByHash: () => mocks.existing ? [mocks.existing] : [],
  findStaleAnnotateDoc: () => null,
}));
vi.mock("./util/whiteboardStore", async (original) => ({
  ...await original<typeof import("./util/whiteboardStore")>(),
  listWhiteboardNotebooks: () => [],
}));
vi.mock("./util/contentStore", async (original) => ({
  ...await original<typeof import("./util/contentStore")>(),
  repairContentStore: async () => ({ promoted: 0, remaining: 0 }),
}));
let root: Root;
let host: HTMLDivElement;
const session: SessionSnapshot = {
  started_at: 0, active_list: null, queue: ["test/two-sum"], problems: {}, reveals: {},
};
const practice: TabRecord = {
  id: "practice", kind: "practice", title: "Two sum", dataset: "test", taskId: "two-sum", dirty: false, lastActive: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduced-motion"), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  localStorage.clear();
  vi.clearAllMocks();
  mocks.api = null;
  mocks.native = true; mocks.existing = null; mocks.liveOriginal = null; mocks.drawPage = false;
  mocks.openFolder.mockReset().mockResolvedValue({ status: "unavailable" });
  mocks.grantFolder.mockReset().mockResolvedValue({ status: "unavailable" });
  mocks.fetch.mockReset(); mocks.serialize.mockReset(); mocks.fromHtml.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const agentPanel = document.createElement("div");
  document.body.append(agentPanel);
  const chrome = document.createElement("div");
  document.body.append(chrome);
  mocks.shell = {
    client: {
      resetSession: mocks.reset, finishAttempt: mocks.finish, reveal: mocks.reveal,
      loadProblem: vi.fn(async () => ({ resume: { attempt: null, board: null, agent_messages: [
        { id: "review", role: "assistant", content: "A review", at: 1, review: {} },
      ] } })),
      getProblem: vi.fn(async () => ({ dataset: "test", key: "test/two-sum", task_id: "two-sum",
        question_id: "1", difficulty: "Easy", tags: [], problem_description: "Add two numbers.",
        starter_code: "def solve():\n    pass\n", entry_point: "solve", cases: [] })),
      getSolution: vi.fn(async () => ({ source: "" })),
      getProblemPad: vi.fn(async () => null), scaffoldBoard: vi.fn(async () => ({})),
      adjacentProblems: vi.fn(async () => ({ prev: null, next: null })),
      putAgentSession: vi.fn(async () => {}),
    },
    mobile: false, serverLinkRef: { current: "online" }, themeId: "paper", readingSize: "M",
    autosaveMs: 0, testForward: "off", recognizer: null, capabilities: null,
    coachFlags: {}, llmLink: "offline", error: null, browseMotion: "idle", holdBrowseOverlay: false,
    session, navigateBySession: false, bankFilters: {},
    tabsRef: { current: { tabs: [practice], activeId: practice.id } }, headerSlots: { left: null, center: null, right: null, chrome, boardChrome: null, agentPanel },
    setThemeId: vi.fn(), setAutosaveMs: vi.fn(), setTestForward: vi.fn(), setPdfFilmOpen: vi.fn(),
    setSettingsOpen: vi.fn(), setNotice: vi.fn(), setError: vi.fn(), announceAutosave: vi.fn(),
    setBrowseMotion: vi.fn(), setHoldBrowseOverlay: vi.fn(), setSession: vi.fn(), refreshSession: vi.fn(async () => {}),
    setNavigateBySession: vi.fn(), setBankFilters: vi.fn(), openWorkspace: vi.fn(), focusTab: vi.fn(),
    openPracticePicker: vi.fn(), closeTab: vi.fn(), splitTabs: vi.fn(), patchTab: vi.fn(), webPush: vi.fn(), webStep: vi.fn(),
    setChrome: vi.fn(), setWorkspaceApi: vi.fn((_id, api) => { mocks.api = api; }),
    setShellLoadActive: vi.fn(), shellLoadActive: false, takeUserLoad: vi.fn(() => false), onMissingContent: vi.fn(),
  } as unknown as ShellValue;

});

afterEach(() => {
  act(() => root.unmount());
  document.body.textContent = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(tab: TabRecord = web) {
  mocks.shell.tabsRef.current = { tabs: [tab], activeId: tab.id, groups: [] };
  await act(async () => root.render(<Workspace tab={tab} active showing practiceRequested={tab.kind === "home"} />));
  await settle();
}

function dialog(label: string) {
  return document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`);
}

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(button => button.textContent === label || button.getAttribute("aria-label") === label || button.querySelector("b")?.textContent === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}

// Native webviews, fetching and document layout are jsdom boundaries. All
// address-bar, freeze, cancellation and shared document-loader handlers are real.
vi.mock("./api/nativeHttp", async original => ({
  ...await original<typeof import("./api/nativeHttp")>(), isTauriRuntime: () => mocks.native,
}));
vi.mock("./util/liveWebviewSupport", () => ({ liveWebviewSupported: () => true }));
vi.mock("./util/liveHtmlStore", async original => ({
  ...await original<typeof import("./util/liveHtmlStore")>(), getLiveOriginal: async () => mocks.liveOriginal,
}));
vi.mock("./util/htmlAssets", () => ({
  openHtmlFolder: (...args: unknown[]) => mocks.openFolder(...args),
  grantHtmlFolder: (...args: unknown[]) => mocks.grantFolder(...args),
  htmlAssetBase: (token: string) => `http://lcasset.localhost/${token}/`,
}));
vi.mock("./util/docSourceNative", async original => ({
  ...await original<typeof import("./util/docSourceNative")>(), nativeSourcePickerAvailable: () => true,
}));
vi.mock("./util/webPage", async original => ({
  ...await original<typeof import("./util/webPage")>(),
  fetchWebPage: (...args: unknown[]) => mocks.fetch(...args),
  pageFromCapturedHtml: (...args: unknown[]) => mocks.fromHtml(...args),
}));
vi.mock("./util/webPageCapture", () => ({
  liveWebviewLabel: (id: string) => `live-${id}`,
  serializeLiveWebview: (...args: unknown[]) => mocks.serialize(...args),
}));
vi.mock("./modes/LiveWebPane", () => ({
  LiveWebPane: ({ url, onNavigate, onBack, onError }: ComponentProps<typeof import("./modes/LiveWebPane").LiveWebPane>) =>
    <section aria-label="Live page" data-url={url}>
      <button onClick={() => onNavigate?.("https://example.com/next")}>Follow live link</button>
      <button onClick={onBack}>Native back</button>
      <button onClick={() => onError?.("Live view failed")}>Fail live view</button>
    </section>,
}));
vi.mock("./util/annotateLaidOut", () => ({ waitForAnnotateLaidOut: async () => true }));
const url = "https://example.com/article";
const html = "<article>Original article</article>";
const web: import("./util/tabs").WebTab = { id: "web", kind: "web", title: "Article", dirty: false, lastActive: 0,
  entries: [{ url, title: "Article", html }], index: 0, docId: null, indexed: "idle" };
async function settle() { await act(async () => {
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(1000);
}); }
function button(label: string) {
  const result = [...document.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === label || b.textContent === label);
  expect(result, label).toBeTruthy(); return result!;
}
function address() { return document.querySelector<HTMLInputElement>(".lc-web-omnibox input")!; }
async function navigate(next: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(address(), next);
    address().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => document.querySelector(".lc-web-omnibox")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
function live() { return document.querySelector('[aria-label="Live page"]'); }
/** The toolbar chip's linked-file half, as last handed to the shell. */
function chromeLink() {
  const calls = vi.mocked(mocks.shell.setChrome).mock.calls;
  return (calls.at(-1)![0] as { docIndex: { link: unknown } }).docIndex.link;
}
function freezeDialog() { return dialog("What kind of page is this?"); }
function withMarks() {
  mocks.existing = {
    id: "saved-web", name: url, docType: "web", hash: docIdentityHash({ name: url, docType: "web", text: html }),
    source: html, updatedAt: 1, board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } },
    footnotes: [{ id: "mark", kind: "note", anchor: { kind: "text", start: 0, end: 16, exact: "Original article" }, excerpt: "Original article", createdAt: 1, updatedAt: 1 }],
  } as AnnotateDoc;
}

it("address capture starts busy, opens the fetched entry in this pane, and retains rendering metadata on failure", async () => {
  mocks.native = false;
  await mount();
  const success = deferred<unknown>(); mocks.fetch.mockReturnValueOnce(success.promise);
  await navigate("https://example.com/new");
  expect(mocks.fetch).toHaveBeenLastCalledWith("https://example.com/new", { mode: "reader" });
  expect(button("Stop loading")).toBeTruthy();
  expect(button("Back").disabled).toBe(true);
  expect(mocks.shell.setError).toHaveBeenLastCalledWith(null);
  expect(mocks.shell.setShellLoadActive).toHaveBeenLastCalledWith(true);
  await act(async () => success.resolve({ url: "https://example.com/final", title: "Final", html: "<p>New</p>", source: "fetch", note: "Native capture unavailable" }));
  await settle();
  expect(address().value).toBe("https://example.com/final");
  expect(mocks.shell.webPush).toHaveBeenLastCalledWith(web.id, { url: "https://example.com/final", title: "Final", html: "<p>New</p>" });
  expect(mocks.shell.openWorkspace).not.toHaveBeenCalled();
  expect(button("Reload page")).toBeTruthy();
  expect(document.querySelector('[title*="Native capture unavailable"]')).toBeTruthy();
  expect(mocks.shell.setShellLoadActive).toHaveBeenLastCalledWith(false);
  const failure = deferred<never>(); mocks.fetch.mockReturnValueOnce(failure.promise);
  await navigate("https://example.com/bad");
  await act(async () => failure.reject(new Error("Fetch failed")));
  expect(mocks.shell.setError).toHaveBeenLastCalledWith("Fetch failed");
  expect(button("Reload page")).toBeTruthy();
  expect(address().value).toBe("https://example.com/bad");
  expect(document.querySelector('[title*="Native capture unavailable"]')).toBeTruthy();
  expect(mocks.shell.webPush).toHaveBeenCalledTimes(1);
});

it.each(["resolve", "reject"] as const)("stop clears loading, keeps the typed address, and ignores a late fetch %s", async outcome => {
  await mount();
  const pending = deferred<unknown>(); mocks.fetch.mockReturnValueOnce(pending.promise);
  await navigate("https://example.com/cancelled");
  await click("Stop loading"); await settle();
  expect(button("Reload page")).toBeTruthy();
  expect(address().value).toBe("https://example.com/cancelled");
  mocks.shell.setError = vi.fn();
  await act(async () => {
    if (outcome === "resolve") pending.resolve({ url: "https://example.com/late", title: "Late", html: "<p>Late</p>", source: "reader" });
    else pending.reject(new Error("Late failure"));
  });
  expect(mocks.shell.webPush).not.toHaveBeenCalled();
  expect(mocks.shell.setError).not.toHaveBeenCalled();
  expect(mocks.shell.setShellLoadActive).toHaveBeenLastCalledWith(false);
  expect(address().value).toBe("https://example.com/cancelled");
});

it("freeze serializes the live page, uses its navigated URL and rendering preference, and leaves a frozen capture", async () => {
  await mount(); expect(live()).toBeTruthy();
  await click("Follow live link");
  expect(address().value).toBe("https://example.com/next");
  expect(mocks.shell.webPush).toHaveBeenLastCalledWith(web.id, { url: "https://example.com/next", title: "example.com" });
  const pending = deferred<{ html: string; url: string }>(); mocks.serialize.mockReturnValueOnce(pending.promise);
  mocks.fromHtml.mockResolvedValueOnce({ url: "https://example.com/deep", html: "<article>Frozen</article>", source: "capture" });
  await click("Freeze this page");
  expect(freezeDialog()).toBeNull(); expect(live()).toBeTruthy();
  expect(button("Stop loading")).toBeTruthy(); expect(loadWebViewMode()).toBe("frozen");
  await act(async () => pending.resolve({ html: "<main>Live DOM</main>", url: "https://example.com/deep" }));
  await settle();
  expect(mocks.serialize).toHaveBeenCalledWith("live-web");
  expect(mocks.fromHtml).toHaveBeenCalledWith("<main>Live DOM</main>", "https://example.com/deep", { mode: "reader" });
  expect(mocks.fetch).not.toHaveBeenCalled(); expect(live()).toBeNull();
  // Current behavior: loadAnnotate sees the committed freeze busy flag and
  // bails; the successful serialization hides Live but keeps the old address.
  expect(address().value).toBe("https://example.com/next");
  expect(button("Browse the live page")).toBeTruthy(); expect(button("Reload page")).toBeTruthy();
  expect(mocks.shell.setError).not.toHaveBeenCalledWith(expect.any(String));
});

it.each(["serialize", "convert"] as const)("freeze %s failure keeps the live view and frozen preference, then allows retry with address fallback", async stage => {
  await mount();
  if (stage === "serialize") mocks.serialize.mockRejectedValueOnce(new Error("Freeze failed"));
  else { mocks.serialize.mockResolvedValueOnce({ html: "Live", url: "" }); mocks.fromHtml.mockRejectedValueOnce(new Error("Freeze failed")); }
  await click("Freeze this page"); await settle();
  expect(mocks.shell.setError).toHaveBeenLastCalledWith("Freeze failed");
  expect(live()).toBeTruthy(); expect(loadWebViewMode()).toBe("frozen"); expect(button("Reload page")).toBeTruthy();
  mocks.serialize.mockResolvedValueOnce({ html: "Retry", url: "" });
  mocks.fromHtml.mockResolvedValueOnce({ url, html: "<p>Retry</p>", source: "reader" });
  await click("Freeze this page"); await settle();
  expect(mocks.fromHtml).toHaveBeenLastCalledWith("Retry", url, { mode: "reader" }); expect(live()).toBeNull();
});

it("marked freeze cancels without capture, reopens, and reports retaining a stranded mark without reloading the document", async () => {
  withMarks(); await mount(); expect(live()).toBeNull();
  await click("Browse the live page"); expect(loadWebViewMode()).toBe("live");
  await click("Freeze this page"); expect(freezeDialog()).toBeTruthy();
  await click("Not now"); expect(freezeDialog()).toBeNull(); expect(live()).toBeTruthy();
  expect(loadWebViewMode()).toBe("frozen"); expect(mocks.serialize).not.toHaveBeenCalled();
  await click("Freeze this page");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(freezeDialog()).toBeNull();
  await click("Freeze this page");
  mocks.serialize.mockResolvedValueOnce({ html: "New feed", url });
  mocks.fromHtml.mockResolvedValueOnce({ url, html: "<p>Different news</p>", source: "reader" });
  await click("A feed"); expect(freezeDialog()).toBeNull(); await settle();
  expect(mocks.shell.setError).not.toHaveBeenCalledWith(expect.any(String));
  expect(live()).toBeNull();
  expect(document.querySelector('[title*="earlier version"]')).toBeNull();
  expect(mocks.shell.setNotice).toHaveBeenCalledWith(expect.stringContaining("kept"));
});

it("a newer address wins over an older in-flight capture", async () => {
  await mount();
  const old = deferred<unknown>();
  mocks.fetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ url: "https://example.com/winner", html: "Winner", title: "Winner", source: "reader" });
  await navigate("https://example.com/old");
  await navigate("https://example.com/winner"); await settle();
  await act(async () => old.resolve({ url: "https://example.com/old", html: "Old", source: "capture" }));
  expect(address().value).toBe("https://example.com/winner");
  expect(mocks.shell.webPush).toHaveBeenCalledTimes(1);
  expect(button("Reload page")).toBeTruthy();
});

it("reader toggle persists the new rendering choice before refetching the current address", async () => {
  await mount();
  mocks.fetch.mockResolvedValueOnce({ url, title: "Article", html, source: "reader" });
  await navigate(url); await settle();
  mocks.fetch.mockResolvedValueOnce({ url, title: "Whole page", html: "<p>Whole page</p>", source: "capture" });
  const toggle = document.querySelector<HTMLButtonElement>('button[aria-pressed="true"][title*="Reader"]');
  expect(toggle).toBeTruthy();
  await act(async () => toggle!.click()); await settle();
  expect(mocks.fetch).toHaveBeenLastCalledWith(url, { mode: "page" });
  expect(localStorage.getItem("whiteboard.webRenderMode.v1")).toBe("page");
  expect(button("Reload page")).toBeTruthy();
});

it("history replays stored HTML without fetching, but fetches live-only placeholders", async () => {
  const tab = { ...web, entries: [{ url: "https://example.com/older", title: "Older" }, ...web.entries], index: 1 };
  await mount(tab);
  mocks.fetch.mockResolvedValueOnce({ url: "https://example.com/older", title: "Older", html: "<p>Older</p>", source: "reader" });
  await click("Back"); await settle();
  expect(mocks.shell.webStep).toHaveBeenCalledWith(web.id, -1);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(mocks.shell.webPush).toHaveBeenCalledWith(web.id, { url: "https://example.com/older", title: "Older", html: "<p>Older</p>" });
  // Match the shell's updated record on the same mounted workspace.
  const filled = { ...tab, entries: [{ url: "https://example.com/older", title: "Older", html: "<p>Older</p>" }, ...web.entries], index: 0 };
  await mount(filled);
  await click("Forward"); await settle();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(mocks.shell.webStep).toHaveBeenLastCalledWith(web.id, 1);
});

it("native Back with no history and native errors expose the frozen copy", async () => {
  await mount();
  await click("Native back"); expect(live()).toBeNull();
  await click("Browse the live page"); expect(live()).toBeTruthy();
  await click("Fail live view"); expect(live()).toBeNull();
  expect(mocks.shell.setError).toHaveBeenLastCalledWith("Live view failed");
  expect(address().value).toBe(url);
});


it("a local web file restores its original identity without touching the address or offering browsing", async () => {
  withMarks();
  const localFileHash = "original-file-content-hash";
  mocks.existing = { ...mocks.existing!, name: "guide.html", hash: localFileHash, localFileHash, footnotes: [] };
  const fileTab: TabRecord = { id: "local-file", kind: "annotate", title: "guide.html", docType: "web",
    hash: localFileHash, docId: mocks.existing.id, dirty: false, lastActive: 0, indexed: "idle", source: null };
  await mount(fileTab);
  expect(mocks.setWebUrl).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.serialize).not.toHaveBeenCalled();
  expect(live()).toBeNull();
  expect(document.querySelector('[aria-label="Page address"]')).toBeNull();
  expect(document.querySelector('[aria-label="Browse the live page"]')).toBeNull();
  expect(document.querySelector('[aria-label="Freeze this page"]')).toBeNull();
  expect(document.querySelector('[aria-label="Reload page"]')).toBeNull();
  expect(mocks.shell.patchTab).toHaveBeenCalledWith(fileTab.id, expect.objectContaining({ hash: localFileHash, docType: "web" }));
  // Opened from a file, so the chip offers to link it and check for a newer version.
  expect(chromeLink()).toMatchObject({ name: null, newer: false });
});

it("an address web document still sets its URL and offers live browsing and reload", async () => {
  await mount();
  expect(mocks.setWebUrl).toHaveBeenCalledWith(url);
  expect(address().value).toBe(url);
  expect(live()).toBeTruthy();
  expect(button("Freeze this page")).toBeTruthy();
  expect(button("Reload page")).toBeTruthy();
  // A page from an address has no file behind it.
  expect(chromeLink()).toBeNull();
});

describe("a live local page's own folder", () => {
  const location = "content://com.android.externalstorage.documents/document/primary%3ADocuments%2Fread%2FGraphs%2Fguide.html";
  async function mountLinked(id: string) {
    withMarks();
    const localFileHash = `original-${id}`;
    mocks.existing = { ...mocks.existing!, id, name: "guide.html", hash: localFileHash, localFileHash, footnotes: [] };
    mocks.liveOriginal = '<video controls src="3.7.mp4"></video>';
    mocks.drawPage = true;
    setDocSource(id, { kind: "uri", location, name: "guide.html", size: 1, modified: 1, hash: localFileHash, checkedAt: 1 });
    await mount({ id: "local-file", kind: "annotate", title: "guide.html", docType: "web",
      hash: localFileHash, docId: id, dirty: false, lastActive: 0, indexed: "idle", source: null });
  }
  const liveFrame = () => document.querySelector<HTMLIFrameElement>("iframe.lc-live-html-frame");

  it("points the live page's relative names at the folder of its linked file", async () => {
    mocks.openFolder.mockResolvedValue({ status: "ready", token: "tok" });
    await mountLinked("linked-ready");
    expect(mocks.openFolder).toHaveBeenCalledWith("uri", location);
    expect(liveFrame()?.srcdoc).toContain('<base href="http://lcasset.localhost/tok/">');
    expect(dialog("Load this page's videos and pictures?")).toBeNull();
  });

  it("asks once for a folder it has only the file of, and loads from it once chosen", async () => {
    mocks.openFolder.mockResolvedValue({ status: "needsAccess", folder: "Graphs" });
    await mountLinked("linked-ask");
    expect(liveFrame()?.srcdoc).not.toContain("<base href");
    expect(dialog("Load this page's videos and pictures?")?.textContent).toContain("“guide.html” loads files from the folder it sits in, “Graphs”.");
    mocks.grantFolder.mockResolvedValueOnce({ status: "wrongFolder" });
    await click("Choose folder…");
    expect(dialog("Load this page's videos and pictures?")?.textContent).toContain("That folder doesn't hold “guide.html”. Choose the folder it's in.");
    mocks.grantFolder.mockResolvedValueOnce({ status: "ready", token: "granted" });
    await click("Choose folder…"); await settle();
    expect(mocks.grantFolder).toHaveBeenLastCalledWith(location);
    expect(dialog("Load this page's videos and pictures?")).toBeNull();
    expect(liveFrame()?.srcdoc).toContain('<base href="http://lcasset.localhost/granted/">');
  });
});
