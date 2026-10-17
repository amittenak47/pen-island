/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LcClient } from "../api/client";
import { BookSyncError, type BookResult } from "../util/bookSync";
import { LIBRARY_SYNC_RESULT_KEY } from "../util/storageKeys";
import { LibrarySyncControl } from "./LibrarySyncControl";
import { librarySyncSummary, loadLibrarySyncResults, rememberLibrarySyncResults } from "./LibrarySyncResults";

const pass = vi.hoisted(() => ({
  activity: { busy: false, library: false, progress: null as { done: number; total: number } | null },
  run: vi.fn(),
}));
vi.mock("../util/bookSyncPass", () => ({ BOOK_PASS_STATUS_EVENT: "lc-book-pass-status", BOOK_PASS_ACTIVITY_EVENT: "lc-book-pass-activity",
  getBookPassActivity: () => pass.activity, syncBookPass: pass.run }));
const api = {} as LcClient;
const row = (id: string, status: BookResult["status"], kind: BookResult["kind"] = "annotate"): BookResult => ({
  kind, id, status, committed: status === "synced", display: { title: id, scratchTitles: {} },
  ...(status === "failed" ? { error: new BookSyncError("storage", "Storage not ready") } : {}),
});
let root: Root, host: HTMLDivElement;
const onOpen = vi.fn();
const trigger = () => host.querySelector("button")!;
const popover = () => document.querySelector<HTMLDivElement>(".lc-library-sync-popover")!;
const button = (text: string) => [...popover().querySelectorAll("button")].find(button => button.textContent === text)!;
const click = (element: HTMLElement) => act(() => element.click());
function mount() { act(() => root.render(<LibrarySyncControl client={api} canOpen={book => book.id !== "missing"} onOpen={onOpen} />)); }
function activity(busy: boolean, library = false, progress: { done: number; total: number } | null = null) {
  act(() => { pass.activity = { busy, library, progress }; window.dispatchEvent(new Event("lc-book-pass-activity")); });
}
function complete(books: BookResult[]) {
  act(() => { rememberLibrarySyncResults(books); window.dispatchEvent(new Event("lc-book-pass-status")); });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); onOpen.mockReset(); pass.run.mockReset();
  pass.activity = { busy: false, library: false, progress: null };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("starts with no result and no dot; closes on outside tap and Escape", () => {
  mount(); expect(trigger().getAttribute("aria-label")).toContain("Not synced yet");
  expect(host.querySelector(".lc-library-sync-dot")).toBeNull();
  click(trigger()); expect(popover().textContent).toContain("Not synced yet");
  act(() => popover().dispatchEvent(new Event("pointerdown", { bubbles: true }))); expect(popover()).not.toBeNull();
  act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))); expect(popover()).toBeNull();
  click(trigger()); act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))); expect(popover()).toBeNull();
});

it("summarizes groups, shows failures first with red crosses, and expands green check rows", () => {
  const saved = rememberLibrarySyncResults([row("good", "synced"), row("same", "unchanged"), row("choice", "needs_choice"), row("bad", "failed"), row("cancel", "cancelled")], 1000);
  mount(); expect(trigger().getAttribute("aria-label")).toContain("1 need your choice");
  expect(host.querySelector(".lc-library-sync-dot")).not.toBeNull(); click(trigger());
  expect(popover().textContent).toContain("2 synced · 1 need your choice · 1 failed · 1 cancelled");
  expect(popover().textContent).toContain(new Date(saved.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  expect(popover().querySelectorAll("li")).toHaveLength(3);
  expect([...popover().querySelectorAll(".lc-library-sync-bad")].map(el => el.textContent)).toEqual(["✗", "✗", "✗"]);
  const reason = popover().querySelector("small")!; expect(reason.title).toBe("Needs your choice");
  click(button("Show all"));
  const rows = [...popover().querySelectorAll("li")]; expect(rows).toHaveLength(5);
  expect(rows[0].textContent).toContain("choice"); expect(rows[3].textContent).toBe("✓good"); expect(rows[4].textContent).toBe("✓same");
  expect(popover().querySelectorAll(".lc-library-sync-ok")).toHaveLength(2);
});

it.each(["annotate", "whiteboard", "problem"] as const)("opens a local failed %s by kind and id and closes", kind => {
  rememberLibrarySyncResults([row("local", "needs_choice", kind), row("missing", "failed", kind)]);
  mount(); click(trigger());
  expect(popover().querySelectorAll("button.lc-library-sync-row")).toHaveLength(1);
  click(popover().querySelector<HTMLButtonElement>("button.lc-library-sync-row")!);
  expect(onOpen).toHaveBeenCalledWith({ kind, id: "local" }); expect(popover()).toBeNull();
});

it("disables sync during tab and silent runs, shows progress, and spins only for library passes", () => {
  mount(); click(trigger()); activity(true);
  expect(button("Sync all books").disabled).toBe(true); expect(popover().textContent).toContain("Sync in progress");
  expect(host.querySelector(".lc-library-sync-spinning")).toBeNull();
  activity(true, true, { done: 6, total: 20 });
  expect(popover().textContent).toContain("Syncing 6 of 20 books"); expect(host.querySelector(".lc-library-sync-spinning")).not.toBeNull();
  activity(false); expect(button("Sync all books").disabled).toBe(false);
});

it("runs a manual library pass without selected/only/silent and cancels through its signal", async () => {
  let finish!: () => void;
  pass.run.mockImplementation(() => { pass.activity = { busy: true, library: true, progress: { done: 1, total: 2 } };
    window.dispatchEvent(new Event("lc-book-pass-activity")); return new Promise<void>(resolve => { finish = resolve; }); });
  mount(); click(trigger()); click(button("Sync all books"));
  expect(pass.run).toHaveBeenCalledOnce(); expect(pass.run.mock.calls[0][0]).toBe(api);
  expect(pass.run.mock.calls[0][1]).toEqual({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) });
  expect(button("Sync all books").disabled).toBe(true); click(button("Cancel"));
  expect(pass.run.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => { finish(); });
});

it("persists compact results across remounts and a single-book result replaces only its row", () => {
  const saved = rememberLibrarySyncResults([row("one", "needs_choice"), row("two", "failed")], 1234);
  expect(loadLibrarySyncResults()).toEqual(saved);
  const json = JSON.parse(localStorage.getItem(LIBRARY_SYNC_RESULT_KEY)!);
  expect(Object.keys(json)).toEqual(["time", "books"]);
  expect(Object.keys(json.books[0])).toEqual(["kind", "id", "title", "status", "reason"]);
  mount(); complete([row("one", "synced")]);
  expect(loadLibrarySyncResults()!.books.map(book => book.status)).toEqual(["synced", "failed"]);
  expect(host.querySelector(".lc-library-sync-dot")).not.toBeNull();
  complete([row("two", "unchanged")]); expect(host.querySelector(".lc-library-sync-dot")).toBeNull();
  act(() => root.unmount()); root = createRoot(host); mount(); click(trigger());
  expect(popover().textContent).toContain("2 synced"); expect(popover().querySelectorAll("li")).toHaveLength(0);
  click(button("Show all")); expect(popover().querySelectorAll("li")).toHaveLength(2);
});

it("ignores malformed stored results", () => {
  localStorage.setItem(LIBRARY_SYNC_RESULT_KEY, '{"time":4,"books":[{"status":"oops"}]}');
  expect(loadLibrarySyncResults()).toBeNull();
  expect(librarySyncSummary({ time: 0, books: [] })).toBe("0 synced");
});
