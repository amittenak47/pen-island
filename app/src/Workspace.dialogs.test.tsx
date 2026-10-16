/** @vitest-environment jsdom */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ShellValue, WorkspaceApi } from "./shellContext";
import type { SessionSnapshot } from "./api/types";
import type { TabRecord } from "./util/tabs";
import type { HubPadConflict } from "./util/hubConflictStash";
import { Workspace } from "./Workspace";
import { HOLD_FILL_MS, HOLD_SENSITIVE_MS } from "./util/gesture";

// Mount Workspace and its real confirmation dialogs. The canvas, remote/local
// I/O and large surrounding panels are boundaries, not replacement handlers.
const mocks = vi.hoisted(() => ({
  shell: {} as ShellValue,
  api: null as WorkspaceApi | null,
  reset: vi.fn(), finish: vi.fn(), reveal: vi.fn(), applyHub: vi.fn(),
  conflict: {} as HubPadConflict,
  conflictDone: vi.fn(),
}));
vi.mock("./shellContext", () => ({ useShell: () => mocks.shell }));
vi.mock("./canvas/boardChunk", () => ({ peekBoardComponent: () => () => null }));
vi.mock("./components/LoadingDoodle", () => ({ LoadingDoodle: () => null }));
vi.mock("./util/bootSettled", () => ({ afterBootSettled: () => new Promise(() => {}) }));
vi.mock("./util/loadingDoodleActivity", () => ({
  isLoadingDoodleActive: () => false, waitForLoadingDoodleIdle: async () => {},
}));
vi.mock("./modes/ProblemBrowser", () => ({
  ProblemBrowser: ({ onResetSession }: ComponentProps<typeof import("./modes/ProblemBrowser").ProblemBrowser>) =>
    <button onClick={onResetSession}>Reset session</button>,
}));
vi.mock("./modes/AgentSidePanel", async (original) => ({
  ...await original<typeof import("./modes/AgentSidePanel")>(),
  AgentSidePanel: ({ messages, onRequestBridge }: ComponentProps<typeof import("./modes/AgentSidePanel").AgentSidePanel>) => <section aria-label="Coach thread">
    {messages.map(message => <article key={message.id}>
      <button onClick={() => onRequestBridge?.(message.id)}>Request bridge</button>
      {message.bridgePending && <p role="status">Bridge pending</p>}
      {message.bridgeError && <p role="alert">{message.bridgeError}</p>}
      {message.bridge && <p>{message.bridge.missing_piece}</p>}
    </article>)}
  </section>,
}));
vi.mock("./components/HubSyncControl", async (original) => ({
  ...await original<typeof import("./components/HubSyncControl")>(),
  HubSyncControl: ({ host }: ComponentProps<typeof import("./components/HubSyncControl").HubSyncControl>) =>
    <button onClick={() => { void host?.onConflict?.(mocks.conflict).then(mocks.conflictDone, mocks.conflictDone); }}>Sync conflict</button>,
}));
// The split needs two canvas previews. Keep its prop contract visible while
// exercising Workspace's real conflict lifecycle and resolve/cancel handlers.
vi.mock("./components/HubConflictSplit", () => ({
  HubConflictSplit: ({ busy, error, onResolve, onCancel }: ComponentProps<typeof import("./components/HubConflictSplit").HubConflictSplit>) =>
    <section role="dialog" aria-label="Sync conflict">
      {busy && <p role="status">Applying choice</p>}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} onClick={() => onResolve({ pick: "server", ink: "server" })}>Keep server</button>
      <button disabled={busy} onClick={onCancel}>Cancel sync</button>
    </section>,
}));
vi.mock("./util/problemBoardStore", async (original) => ({
  ...await original<typeof import("./util/problemBoardStore")>(),
  getProblemBoard: async () => null,
}));
vi.mock("./util/annotateStore", async (original) => ({
  ...await original<typeof import("./util/annotateStore")>(),
  listAnnotateDocs: () => [], migrateAnnotateKeysToId: async () => {},
}));
vi.mock("./util/whiteboardStore", async (original) => ({
  ...await original<typeof import("./util/whiteboardStore")>(),
  listWhiteboardNotebooks: () => [],
}));
vi.mock("./util/contentStore", async (original) => ({
  ...await original<typeof import("./util/contentStore")>(),
  repairContentStore: async () => ({ promoted: 0, remaining: 0 }),
}));
vi.mock("./util/padSync", async (original) => ({
  ...await original<typeof import("./util/padSync")>(),
  applyHubWhiteboard: (...args: unknown[]) => mocks.applyHub(...args),
}));
vi.mock("./util/inkSync", async (original) => ({
  ...await original<typeof import("./util/inkSync")>(),
  applyInkChoice: async () => {},
}));

let root: Root;
let host: HTMLDivElement;
const session: SessionSnapshot = {
  started_at: 0, active_list: null, queue: ["test/two-sum"], problems: {}, reveals: {},
};
const home: TabRecord = { id: "home", kind: "home", title: "Home", dirty: false, lastActive: 0 };
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
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const agentPanel = document.createElement("div");
  document.body.append(agentPanel);
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
    tabsRef: { current: { tabs: [practice], activeId: practice.id } }, headerSlots: { left: null, center: null, right: null, chrome: null, boardChrome: null, agentPanel },
    setThemeId: vi.fn(), setAutosaveMs: vi.fn(), setTestForward: vi.fn(), setPdfFilmOpen: vi.fn(),
    setSettingsOpen: vi.fn(), setNotice: vi.fn(), setError: vi.fn(), announceAutosave: vi.fn(),
    setBrowseMotion: vi.fn(), setHoldBrowseOverlay: vi.fn(), setSession: vi.fn(), refreshSession: vi.fn(async () => {}),
    setNavigateBySession: vi.fn(), setBankFilters: vi.fn(), openWorkspace: vi.fn(), focusTab: vi.fn(),
    openPracticePicker: vi.fn(), closeTab: vi.fn(), splitTabs: vi.fn(), patchTab: vi.fn(), webPush: vi.fn(), webStep: vi.fn(),
    setChrome: vi.fn(), setWorkspaceApi: vi.fn((_id, api) => { mocks.api = api; }),
    setShellLoadActive: vi.fn(), shellLoadActive: false, takeUserLoad: vi.fn(() => false), onMissingContent: vi.fn(),
  } as unknown as ShellValue;
  mocks.conflict = {
    kind: "whiteboard", id: "other-board", stage: "pad", detail: "Choose a copy", local: null,
    server: { id: "other-board", board: { v: 1, elements: [], appState: {} } },
  } as HubPadConflict;
});

afterEach(() => {
  act(() => root.unmount());
  document.body.textContent = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(tab: TabRecord) {
  await act(async () => root.render(<Workspace tab={tab} active showing practiceRequested={tab.kind === "home"} />));
}

function dialog(label: string) {
  return document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`);
}

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(button => button.textContent === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}

async function hold(label: string, duration = HOLD_FILL_MS) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, label).toBeTruthy();
  await act(async () => { button!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(duration + 50); });
  await act(async () => { button!.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })); });
}

it("reset: cancels, waits for success, keeps failures open, and clears the error on reopening", async () => {
  await mount(home);
  await click("Reset session");
  expect(dialog("Reset the practice session?")).toBeTruthy();
  await click("Keep session");
  expect(dialog("Reset the practice session?")).toBeNull();
  expect(mocks.reset).not.toHaveBeenCalled();

  await click("Reset session");
  const success = deferred<SessionSnapshot>();
  mocks.reset.mockReturnValueOnce(success.promise);
  await hold("Hold to confirm: Reset");
  expect([...dialog("Reset the practice session?")!.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(dialog("Reset the practice session?")).toBeTruthy();
  const cleared = { ...session, queue: [] };
  await act(async () => success.resolve(cleared));
  expect(dialog("Reset the practice session?")).toBeNull();
  expect(mocks.shell.setSession).toHaveBeenCalledWith(cleared);
  expect(mocks.shell.setNavigateBySession).toHaveBeenCalledWith(false);

  await click("Reset session");
  expect(dialog("Reset the practice session?")!.querySelector("button")!.disabled).toBe(false);
  const failure = deferred<SessionSnapshot>();
  mocks.reset.mockReturnValueOnce(failure.promise);
  await hold("Hold to confirm: Reset");
  await act(async () => failure.reject({ message: "Reset failed" }));
  expect(dialog("Reset the practice session?")!.textContent).toContain("Reset failed");
  expect([...dialog("Reset the practice session?")!.querySelectorAll("button")].every(button => !button.disabled)).toBe(true);
  await click("Keep session");
  await click("Reset session");
  expect(dialog("Reset the practice session?")!.textContent).not.toContain("Reset failed");
});

it("leave: cancels, fades while saving, closes before continuation, recovers failures and clears errors on reopening", async () => {
  await mount(practice);
  // Revealing is an authored edit even without a canvas. It makes this attempt dirty.
  mocks.reveal.mockResolvedValueOnce({ missing_piece: "A bridge", steps: [] });
  await click("Request bridge");
  await hold("Hold to reveal", HOLD_SENSITIVE_MS);
  let completed = false;
  const leave = async () => { await act(async () => { void mocks.api!.leave().then(() => { completed = true; }); }); };
  await leave();
  expect(dialog("Save your progress?")).toBeTruthy();
  await click("Keep working");
  expect(dialog("Save your progress?")).toBeNull();
  expect(completed).toBe(false);
  expect(mocks.finish).not.toHaveBeenCalled();

  await leave();
  const success = deferred<{ kept_layout: boolean }>();
  mocks.finish.mockReturnValueOnce(success.promise);
  await hold("Hold to confirm: Save progress");
  expect(document.querySelector(".lc-leave-dialog-exit")).toBeTruthy();
  expect([...dialog("Save your progress?")!.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
  expect(completed).toBe(false);
  await act(async () => { success.resolve({ kept_layout: true }); await vi.advanceTimersByTimeAsync(200); });
  expect(dialog("Save your progress?")).toBeNull();
  expect(completed).toBe(true);
  expect(mocks.finish).toHaveBeenLastCalledWith("two-sum", { solved: false, save: true }, "test");

  await leave();
  expect(dialog("Save your progress?")!.querySelector("button")!.disabled).toBe(false);
  const failure = deferred<never>();
  mocks.finish.mockReturnValueOnce(failure.promise);
  await hold("Hold to confirm: Save progress");
  await act(async () => { failure.reject(new Error("Save failed")); await vi.advanceTimersByTimeAsync(200); });
  expect(dialog("Save your progress?")!.textContent).toContain("Save failed");
  expect(document.querySelector(".lc-leave-dialog-exit")).toBeNull();
  expect([...dialog("Save your progress?")!.querySelectorAll("button")].every(button => !button.disabled)).toBe(true);
  await click("Keep working");
  await leave();
  expect(dialog("Save your progress?")!.textContent).not.toContain("Save failed");
});

it.each(["bridge", "lazy"] as const)("reveal %s: closes before the action, keeps pending/error on the coach message, and reopens cleanly", async mode => {
  await mount(practice);
  await click("Request bridge");
  expect(dialog("Reveal reference")).toBeTruthy();
  await click("Keep trying");
  expect(dialog("Reveal reference")).toBeNull();
  expect(mocks.reveal).not.toHaveBeenCalled();

  const confirm = () => hold(mode === "bridge" ? "Hold to reveal" : "Hold to lazy-fill solution code", HOLD_SENSITIVE_MS);
  const success = deferred<{ missing_piece: string; steps: never[] }>();
  mocks.reveal.mockReturnValueOnce(success.promise);
  await click("Request bridge");
  await confirm();
  expect(dialog("Reveal reference")).toBeNull();
  expect(document.querySelector('[aria-label="Coach thread"]')!.textContent).toContain("Bridge pending");
  expect(mocks.reveal).toHaveBeenLastCalledWith("two-sum", { recognized_text: "" }, true, "test", mode);
  await act(async () => success.resolve({ missing_piece: "The missing piece", steps: [] }));
  expect(document.body.textContent).toContain("The missing piece");
  expect(document.body.textContent).not.toContain("Bridge pending");

  const failure = deferred<never>();
  mocks.reveal.mockReturnValueOnce(failure.promise);
  await click("Request bridge");
  await confirm();
  expect(dialog("Reveal reference")).toBeNull();
  await act(async () => failure.reject(new Error("Reveal failed")));
  expect(dialog("Reveal reference")).toBeNull();
  expect(document.querySelector('[aria-label="Coach thread"] [role="alert"]')!.textContent).toBe("Reveal failed");
  expect(document.body.textContent).not.toContain("Bridge pending");
  await click("Request bridge");
  expect(dialog("Reveal reference")!.textContent).not.toContain("Reveal failed");
  expect(dialog("Reveal reference")!.querySelector('[role="status"]')).toBeNull();
  expect(dialog("Reveal reference")!.querySelector("button")!.disabled).toBe(false);
  // Reopening does not erase the previous failure from the coach thread.
  expect(document.querySelector('[aria-label="Coach thread"] [role="alert"]')!.textContent).toBe("Reveal failed");
});

it("hub conflict: cancels the waiting walk, waits for apply, keeps failures open, and reopens without the old error", async () => {
  await mount(practice);
  await click("Sync conflict");
  expect(dialog("Sync conflict")).toBeTruthy();
  await click("Cancel sync");
  expect(dialog("Sync conflict")).toBeNull();
  expect(mocks.conflictDone).toHaveBeenCalledTimes(1);
  expect(mocks.applyHub).not.toHaveBeenCalled();

  await click("Sync conflict");
  const success = deferred<void>();
  mocks.applyHub.mockReturnValueOnce(success.promise);
  await click("Keep server");
  expect(dialog("Sync conflict")!.textContent).toContain("Applying choice");
  expect([...dialog("Sync conflict")!.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
  await act(async () => success.resolve());
  expect(dialog("Sync conflict")).toBeNull();
  expect(mocks.conflictDone).toHaveBeenCalledTimes(2);

  await click("Sync conflict");
  expect(dialog("Sync conflict")!.querySelector("button")!.disabled).toBe(false);
  const failure = deferred<void>();
  mocks.applyHub.mockReturnValueOnce(failure.promise);
  await click("Keep server");
  await act(async () => failure.reject(new Error("Apply failed")));
  expect(dialog("Sync conflict")!.textContent).toContain("Apply failed");
  expect(dialog("Sync conflict")!.querySelector('[role="status"]')).toBeNull();
  expect([...dialog("Sync conflict")!.querySelectorAll("button")].every(button => !button.disabled)).toBe(true);
  expect(mocks.shell.setError).toHaveBeenCalledWith("Apply failed");
  await click("Cancel sync");
  await click("Sync conflict");
  expect(dialog("Sync conflict")!.textContent).not.toContain("Apply failed");
});
