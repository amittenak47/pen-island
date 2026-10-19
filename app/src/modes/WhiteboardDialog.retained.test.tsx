/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LIBRARY_HOLD_MS } from "../util/gesture";
import type { WhiteboardNotebookMeta } from "../util/whiteboardStore";
import type { RetainedVersion } from "../util/retainedVersions";

const live = vi.hoisted(() => ({ rows: [] as WhiteboardNotebookMeta[], trash: [] as WhiteboardNotebookMeta[] }));
const store = vi.hoisted(() => ({ versions: new Map<string, RetainedVersion[]>() }));
const calls = vi.hoisted(() => ({
  trashCopy: vi.fn(async () => {}), deleteCopies: vi.fn(async () => {}), deleteBookCopies: vi.fn(async () => {}),
  deleteNotebook: vi.fn(async () => {}), restore: vi.fn(async (): Promise<"restored" | "stale"> => "restored"),
  backup: vi.fn(async (): Promise<string | null> => "Saved Notes-backup.json"),
}));

vi.mock("../util/whiteboardStore", () => ({
  WHITEBOARD_LIBRARY_EVENT: "lc-whiteboard-library",
  listWhiteboardNotebooks: () => live.rows,
  listWhiteboardTrash: () => live.trash,
  deleteWhiteboardNotebook: calls.deleteNotebook,
  setWhiteboardNotebookLocked: vi.fn(),
}));
vi.mock("../util/padSnapshotStore", () => ({ listPadSnapshots: async () => [], PAD_SNAPSHOT_TIERS: [] }));
vi.mock("../util/padSync", () => ({ TOMBSTONE_COPY: "Trash on this device." }));
vi.mock("../util/retainedVersions", async original => ({
  ...await original<typeof import("../util/retainedVersions")>(),
  versionsByBook: async () => ({ versions: store.versions, attached: new Map() }),
  bookBytes: async () => 2048,
  trashRetainedCopy: calls.trashCopy,
  deleteRetainedCopies: calls.deleteCopies,
  deleteBookRetainedCopies: calls.deleteBookCopies,
}));
vi.mock("./retainedActions", () => ({ restoreVersion: calls.restore, exportVersionBackup: calls.backup }));

import { WhiteboardDialog } from "./WhiteboardDialog";

const version = (id: string, bookId: string, number: number, extra: Partial<RetainedVersion> = {}): RetainedVersion => ({
  id, kind: "whiteboard", bookId, number, editedAt: Date.UTC(2026, 9, 18 - number), keptAt: 0,
  reason: "The hub's version, from a sync choice", name: "Notes", label: "", hash: "", docType: "",
  dataBytes: 4096, trashedAt: null, restore: "record", ...extra,
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
    Element.prototype.releasePointerCapture = function () {};
    Element.prototype.hasPointerCapture = function () { return true; };
  }
  if (typeof PointerEvent === "undefined") {
    class FakePointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0; }
    }
    // @ts-expect-error jsdom lacks PointerEvent
    globalThis.PointerEvent = FakePointerEvent;
  }
});
beforeEach(() => {
  live.rows = [{ id: "nb", title: "Notes", pageCount: 3, updatedAt: 5 } as WhiteboardNotebookMeta];
  live.trash = [];
  store.versions = new Map([["nb", [version("c1", "nb", 1)]]]);
  for (const fn of Object.values(calls)) fn.mockClear();
});
const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.textContent = "";
});

async function mount() {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  const onChoose = vi.fn(), onExportVersion = vi.fn(), onNotice = vi.fn();
  await act(async () => { root.render(<WhiteboardDialog mode="entry" onChoose={onChoose} onCancel={vi.fn()} onExportVersion={onExportVersion} onNotice={onNotice} />); });
  return { onChoose, onExportVersion, onNotice };
}
const byLabel = (pattern: RegExp) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => pattern.test(button.getAttribute("aria-label") ?? button.textContent ?? ""));
async function press(button: HTMLElement, hold: boolean) {
  await act(async () => { button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 })); });
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, hold ? LIBRARY_HOLD_MS + 50 : 10));
    button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function load() {
  await press(byLabel(/^Hold to confirm: Open$/)!, true);
  await press(byLabel(/^Hold to confirm: Load$/)!, true);
}
async function pickCopy(number: number | "Now") {
  await act(async () => { byLabel(/Choose a version/)!.click(); });
  const item = [...document.querySelectorAll<HTMLButtonElement>(".lc-version-menu button")]
    .find(button => button.querySelector(".lc-version-num")?.textContent?.startsWith(String(number)))!;
  await act(async () => { item.click(); });
  // The row's text swaps with motion: the old one leaves before the new one shows.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
}
const row = () => document.querySelector<HTMLElement>(".lc-scratch-load-entry")!;

describe("retained copies in the whiteboard Load list", () => {
  it("has no Retained copies screen, and shows each notebook's size and copies", async () => {
    await mount();
    await press(byLabel(/^Hold to confirm: Open$/)!, true);
    expect(byLabel(/Retained copies/)).toBeUndefined();
    await press(byLabel(/^Hold to confirm: Load$/)!, true);
    expect(row().querySelector(".lc-library-size")?.textContent).toBe("2 KB");
    expect(byLabel(/Choose a version/)!.getAttribute("aria-label")).toContain("1 retained copy");
  });

  it("restores a picked copy and loads the notebook; trashing marks only that copy", async () => {
    const view = await mount(); await load();
    await pickCopy(1);
    expect(row().querySelector(".lc-version-line")!.textContent).toContain("Copy 1");
    expect(row().querySelector(".lc-library-size")!.textContent).toBe("4 KB");
    await press(byLabel(/Move copy 1 of Notes to the trash/)!, true);
    expect(calls.trashCopy).toHaveBeenCalledWith("c1");
    expect(calls.deleteNotebook).not.toHaveBeenCalled();
    await press(byLabel(/^Hold to confirm: Restore copy 1 of Notes$/)!, true);
    expect(calls.restore).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }), false);
    expect(view.onChoose).toHaveBeenCalledWith("load", "nb");
  });

  it("exports: tap for the annotated notebook, hold for the backup file", async () => {
    const view = await mount(); await load();
    await press(byLabel(/^Export Notes: tap/)!, false);
    expect(view.onExportVersion).toHaveBeenCalledWith("nb", null);
    await press(byLabel(/^Export Notes: tap/)!, true);
    expect(calls.backup).toHaveBeenCalledWith("whiteboard", "nb", "Notes", null);
    expect(view.onNotice).toHaveBeenCalledWith("Saved Notes-backup.json");
  });

  it("deletes a trashed notebook for good with its copies, and lists copies whose notebook is gone", async () => {
    live.rows = []; live.trash = [{ id: "nb", title: "Notes", pageCount: 3, updatedAt: 5, deletedAt: 6 } as WhiteboardNotebookMeta];
    store.versions = new Map([["nb", [version("c1", "nb", 1)]], ["gone", [version("g1", "gone", 1, { name: "Old board" })]]]);
    await mount(); await load();
    const rows = [...document.querySelectorAll<HTMLElement>(".lc-library-trash-section .lc-scratch-load-entry")];
    expect(rows.map(node => node.textContent ?? "").some(text => text.includes("Notes") && text.includes("1 retained copy"))).toBe(true);
    expect(rows.map(node => node.textContent ?? "").some(text => text.includes("Old board") && text.includes("Only retained copies"))).toBe(true);
    const notes = rows.find(node => node.textContent?.includes("Notes"))!;
    await act(async () => { notes.querySelector<HTMLButtonElement>(".lc-scratch-load-lock")!.click(); });
    await press(byLabel(/Permanently delete Notes$/)!, true);
    expect(calls.deleteNotebook).toHaveBeenCalledWith("nb", true);
    expect(calls.deleteBookCopies).toHaveBeenCalledWith("whiteboard", "nb");
  });
});
