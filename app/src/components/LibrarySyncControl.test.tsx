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
const pop = () => document.querySelector<HTMLDivElement>(".lc-library-sync-pop");
const click = (element: HTMLElement) => act(() => element.click());
function mount() { act(() => root.render(<LibrarySyncControl client={api} canOpen={book => book.id !== "missing"} onOpen={onOpen} />)); }
function activity(busy: boolean, library = false, progress: { done: number; total: number } | null = null) {
  act(() => { pass.activity = { busy, library, progress }; window.dispatchEvent(new Event("lc-book-pass-activity")); });
}
function complete(books: BookResult[]) {
  act(() => { rememberLibrarySyncResults(books); window.dispatchEvent(new Event("lc-book-pass-status")); });
}
/** A pass that stays running until `finish()`, publishing activity like the real one. */
function holdPass() {
  let finish!: () => void;
  pass.run.mockImplementation(() => {
    pass.activity = { busy: true, library: true, progress: { done: 1, total: 20 } };
    window.dispatchEvent(new Event("lc-book-pass-activity"));
    return new Promise<void>(resolve => { finish = () => { pass.activity = { busy: false, library: false, progress: null };
      window.dispatchEvent(new Event("lc-book-pass-activity")); resolve(); }; });
  });
  return () => finish();
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); onOpen.mockReset(); pass.run.mockReset();
  pass.activity = { busy: false, library: false, progress: null };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("a tap runs the Pull pass and opens the tab's sync notification; a tap while running cancels", async () => {
  const finish = holdPass();
  mount(); expect(trigger().getAttribute("aria-label")).toContain("not synced yet");
  expect(host.querySelector(".lc-library-sync-dot")).toBeNull();
  click(trigger());
  expect(pass.run).toHaveBeenCalledOnce(); expect(pass.run.mock.calls[0][0]).toBe(api);
  // Sync all is the Pull pass: it also adds books this device never had.
  expect(pass.run.mock.calls[0][1]).toEqual({ signal: expect.any(AbortSignal), libraryPull: true, onProgress: expect.any(Function) });
  expect(pop()!.classList.contains("lc-doc-sync-pop")).toBe(true);
  expect(pop()!.querySelector(".lc-doc-sync-line")!.textContent).toBe("Syncing 1 of 20 books");
  expect(trigger().getAttribute("aria-label")).toContain("Cancel sync");
  click(trigger()); expect(pass.run.mock.calls[0][1].signal.aborted).toBe(true);
  expect(pass.run).toHaveBeenCalledOnce();
  await act(async () => { finish(); });
});

it("shows the tab's progress ring with the number of books synced so far", async () => {
  const finish = holdPass(); mount(); click(trigger());
  activity(true, true, { done: 6, total: 20 });
  expect(trigger().querySelector(".lc-doc-index-ring")).not.toBeNull();
  expect(trigger().querySelector(".lc-doc-index-ring-pct")!.textContent).toBe("5");
  expect(pop()!.textContent).toContain("Syncing 6 of 20 books");
  await act(async () => { finish(); });
  expect(trigger().querySelector(".lc-doc-index-ring")).toBeNull();
});

it("a clean finish says synced and closes like the tab's notification", async () => {
  vi.useFakeTimers(); const finish = holdPass(); mount(); click(trigger());
  complete([row("good", "synced")]); await act(async () => { finish(); });
  expect(pop()!.querySelector(".lc-doc-sync-line")!.textContent).toBe("synced");
  act(() => { vi.advanceTimersByTime(2_600); }); expect(pop()).toBeNull();
});

it("a finish with failures stays open with the summary, then Failed (open) and Succeeded (closed) groups", async () => {
  vi.useFakeTimers(); const finish = holdPass(); mount(); click(trigger());
  complete([row("good", "synced"), row("same", "unchanged"), row("choice", "needs_choice"), row("bad", "failed"), row("cancel", "cancelled")]);
  await act(async () => { finish(); });
  act(() => { vi.advanceTimersByTime(5_000); }); expect(pop()).not.toBeNull();
  expect(pop()!.querySelector(".lc-doc-sync-line")!.textContent).toBe("2 synced · 1 need your choice · 1 failed · 1 cancelled");
  expect(host.querySelector(".lc-library-sync-dot")).not.toBeNull();
  expect([...pop()!.querySelectorAll("button")].some(b => /Show/.test(b.textContent ?? ""))).toBe(false);
  const groups = [...pop()!.querySelectorAll(".lc-library-sync-group")];
  expect(groups.map(g => g.querySelector(".lc-library-sync-summary")!.textContent)).toEqual(["▸Failed (3)", "▸Succeeded (2)"]);
  expect(groups.map(g => g.querySelector(".lc-library-sync-summary")!.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
  // Folding is a slide, not an instant <details>: the toggle flips data-open.
  click(groups[1].querySelector<HTMLButtonElement>(".lc-library-sync-summary")!);
  expect(groups[1].hasAttribute("data-open")).toBe(true);
  expect([...groups[0].querySelectorAll("li")].map(li => li.textContent)).toEqual(["✗choiceNeeds your choice", "✗badlocal storage isn't ready for safe sync. Your changes are kept on this device.", "✗cancelCancelled"]);
  expect([...groups[1].querySelectorAll("li")].map(li => li.textContent)).toEqual(["✓good", "✓same"]);
});

it.each(["annotate", "whiteboard", "problem"] as const)("opens a local failed %s by kind and id and closes", async kind => {
  const finish = holdPass(); mount(); click(trigger());
  complete([row("local", "needs_choice", kind), row("missing", "failed", kind)]); await act(async () => { finish(); });
  expect(pop()!.querySelectorAll("button.lc-library-sync-row")).toHaveLength(1);
  click(pop()!.querySelector<HTMLButtonElement>("button.lc-library-sync-row")!);
  expect(onOpen).toHaveBeenCalledWith({ kind, id: "local" }); expect(pop()).toBeNull();
});

it("does not start another pass while a tab or automatic sync runs; it shows that one", () => {
  mount(); activity(true);
  click(trigger()); expect(pass.run).not.toHaveBeenCalled();
  expect(pop()!.textContent).toContain("Sync in progress");
  expect(trigger().querySelector(".lc-doc-index-ring")).toBeNull();
});

it("a full pass drops failures for books it no longer has work for", () => {
  rememberLibrarySyncResults([row("one", "failed"), row("two", "failed"), row("three", "synced")], 1);
  const full = rememberLibrarySyncResults([row("two", "unchanged")], 2, true);
  expect(full.books.map(book => [book.id, book.status])).toEqual([["two", "unchanged"], ["three", "synced"]]);
  const single = rememberLibrarySyncResults([row("four", "failed")], 3);
  expect(single.books.map(book => book.id)).toEqual(["two", "three", "four"]);
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
  act(() => root.unmount()); root = createRoot(host); mount();
  expect(trigger().getAttribute("aria-label")).toContain("all books synced");
});

it("ignores malformed stored results", () => {
  localStorage.setItem(LIBRARY_SYNC_RESULT_KEY, '{"time":4,"books":[{"status":"oops"}]}');
  expect(loadLibrarySyncResults()).toBeNull();
  expect(librarySyncSummary({ time: 0, books: [] })).toBe("0 synced");
});
it("rows say when a book was deleted or restored on another device", async () => {
  // Other device deletes an unchanged book (followed), restores another, and deletes an edited one (choice).
  vi.useFakeTimers(); const finish = holdPass(); mount(); click(trigger());
  complete([{ ...row("followed", "synced"), notice: "deleted_elsewhere" }, { ...row("back", "synced"), notice: "restored_elsewhere" },
    { ...row("edited", "needs_choice"), error: new BookSyncError("needs_choice", "x", [], undefined, "deleted_elsewhere") }]);
  await act(async () => { finish(); });
  const groups = [...pop()!.querySelectorAll(".lc-library-sync-group")];
  expect([...groups[0].querySelectorAll("li")].map(li => li.textContent)).toEqual(["✗editedDeleted on another device. Open it to keep or delete."]);
  expect([...groups[1].querySelectorAll("li")].map(li => li.textContent)).toEqual(["✓followedDeleted on another device. Moved to trash.", "✓backRestored on another device."]);
});
