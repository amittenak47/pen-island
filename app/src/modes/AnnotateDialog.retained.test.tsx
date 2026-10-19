/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LIBRARY_HOLD_MS } from "../util/gesture";
import type { AnnotateDocMeta } from "../util/annotateStore";
import type { RetainedVersion } from "../util/retainedVersions";

const live = vi.hoisted(() => ({ rows: [] as AnnotateDocMeta[], trash: [] as AnnotateDocMeta[] }));
const store = vi.hoisted(() => ({ versions: new Map<string, RetainedVersion[]>() }));
const calls = vi.hoisted(() => ({
  trashCopy: vi.fn(async () => {}), deleteCopies: vi.fn(async () => {}), deleteBookCopies: vi.fn(async () => {}),
  deleteDoc: vi.fn(async () => {}), restore: vi.fn(async (): Promise<"restored" | "stale"> => "restored"),
  backup: vi.fn(async (): Promise<string | null> => "Saved Book-copy-1-backup.json"),
}));

vi.mock("../util/annotateStore", () => ({
  ANNOTATE_LIBRARY_EVENT: "lc-annotate-library",
  listAnnotateDocs: () => live.rows,
  listAnnotateTrash: () => live.trash,
  trashAnnotateDoc: vi.fn(),
  deleteAnnotateDoc: calls.deleteDoc,
  setAnnotateDocLocked: vi.fn(),
  annotateDocLabel: (doc: AnnotateDocMeta) => doc.label?.trim() || doc.name,
}));
vi.mock("../util/padSnapshotStore", () => ({ listPadSnapshots: async () => [], PAD_SNAPSHOT_TIERS: [] }));
vi.mock("../util/padSync", () => ({ TOMBSTONE_COPY: "Trash on this device." }));
vi.mock("../util/docSourceStore", () => ({ listDocSources: () => ({}) }));
vi.mock("../util/docSourceUpdate", () => ({ checkDocSource: vi.fn(), updateDocFromSource: vi.fn(), DOC_SOURCE_CHECKED_EVENT: "lc-doc-source-checked" }));
vi.mock("../util/retainedVersions", async original => ({
  ...await original<typeof import("../util/retainedVersions")>(),
  versionsByBook: async () => ({ versions: store.versions, attached: new Map() }),
  bookBytes: async () => 3 * 1024 * 1024,
  trashRetainedCopy: calls.trashCopy,
  deleteRetainedCopies: calls.deleteCopies,
  deleteBookRetainedCopies: calls.deleteBookCopies,
}));
vi.mock("./retainedActions", () => ({ restoreVersion: calls.restore, exportVersionBackup: calls.backup }));

import { AnnotateDialog } from "./AnnotateDialog";

const version = (id: string, bookId: string, number: number, extra: Partial<RetainedVersion> = {}): RetainedVersion => ({
  id, kind: "annotate", bookId, number, editedAt: Date.UTC(2026, 9, 18 - number), keptAt: 0,
  reason: "Before updating to a newer file", name: "Book.pdf", label: "", hash: "binold-0", docType: "pdf",
  dataBytes: 1024, trashedAt: null, restore: "record", ...extra,
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
  live.rows = [{ id: "book", name: "Book.pdf", hash: "binnew-0", docType: "pdf", updatedAt: 5 }];
  live.trash = [];
  store.versions = new Map([["book", [version("c1", "book", 1), version("c2", "book", 2, { name: "Book (old).pdf" })]]]);
  for (const fn of Object.values(calls)) fn.mockClear();
  calls.restore.mockResolvedValue("restored");
});
const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  // Unmount first: the menus' notifications live in portals on the body.
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.textContent = "";
});

async function mount(props: Record<string, unknown> = {}) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  const onChoose = vi.fn(), onExportVersion = vi.fn(), onNotice = vi.fn();
  await act(async () => { root.render(<AnnotateDialog mode="entry" onChoose={onChoose} onCancel={vi.fn()} onExportVersion={onExportVersion} onNotice={onNotice} {...props} />); });
  return { host, onChoose, onExportVersion, onNotice, unmount: () => act(() => root.unmount()) };
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
async function recents() {
  await press(byLabel(/^Hold to confirm: Open$/)!, true);
  await press(byLabel(/^Hold to confirm: Recents$/)!, true);
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

describe("retained copies in Recents", () => {
  it("has no Retained copies screen in the menu any more", async () => {
    await mount();
    await press(byLabel(/^Hold to confirm: Open$/)!, true);
    expect(byLabel(/Retained copies/)).toBeUndefined();
  });

  it("shows the current version with its size, and a numbered list between the padlock and the trash", async () => {
    await mount(); await recents();
    expect(row().querySelector(".lc-library-size")?.textContent).toBe("3.0 MB");
    const at = (name: string) => [...row().children].findIndex(child => child.classList.contains(name));
    expect(at("lc-scratch-load-lock")).toBeGreaterThan(-1);
    expect(at("lc-scratch-load-lock")).toBeLessThan(at("lc-version-pick"));
    expect(at("lc-version-pick")).toBeLessThan(at("lc-version-share"));
    expect(at("lc-version-share")).toBeLessThan(at("lc-scratch-load-trash"));
    expect(byLabel(/Choose a version/)!.getAttribute("aria-label")).toContain("2 retained copies");
    await act(async () => { byLabel(/Choose a version/)!.click(); });
    expect([...document.querySelectorAll(".lc-version-menu .lc-version-num")].map(node => node.textContent)).toEqual(["Now", "1", "2"]);
  });

  it("shows 0 for a book with no copies, in the same place, so the columns line up", async () => {
    live.rows = [...live.rows, { id: "plain", name: "Plain.md", hash: "h", docType: "markdown", updatedAt: 4 }];
    await mount(); await recents();
    const rows = [...document.querySelectorAll<HTMLElement>(".lc-settings-choice > .lc-scratch-load-entry")];
    const plain = rows.find(node => node.textContent?.includes("Plain.md"))!;
    const pick = plain.querySelector<HTMLButtonElement>(".lc-version-pick")!;
    expect(pick.textContent).toBe("0");
    expect(pick.disabled).toBe(true);
    expect(pick.getAttribute("aria-label")).toContain("no retained copies");
    // Same controls, same order, on a row with copies and a row without.
    const order = (row: HTMLElement) => [...row.children].map(child =>
      ["lc-scratch-load-lock", "lc-version-pick", "lc-version-share", "lc-scratch-load-trash"].find(name => child.classList.contains(name))).filter(Boolean);
    expect(order(plain)).toEqual(order(rows.find(node => node.textContent?.includes("Book.pdf"))!));
  });

  it("shows a picked copy's own name, why it was kept and its size, and goes back to Now", async () => {
    await mount(); await recents();
    await pickCopy(2);
    expect(row().classList.contains("is-copy")).toBe(true);
    expect(row().querySelector("strong")!.textContent).toBe("Book (old).pdf");
    expect(row().querySelector(".lc-version-line")!.textContent).toContain("Copy 2");
    expect(row().querySelector(".lc-version-line")!.textContent).toContain("Before updating to a newer file");
    // Its data plus its file, which is not the file the book uses now (length 0 here).
    expect(row().querySelector(".lc-library-size")!.textContent).toBe("1 KB");
    await pickCopy("Now");
    expect(row().classList.contains("is-copy")).toBe(false);
    expect(row().querySelector("strong")!.textContent).toBe("Book.pdf");
  });

  it("restores a picked copy on hold to open, then opens the book", async () => {
    const view = await mount(); await recents();
    await pickCopy(1);
    await press(byLabel(/^Hold to confirm: Restore copy 1 of Book\.pdf$/)!, true);
    expect(calls.restore).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }), false);
    expect(view.onChoose).toHaveBeenCalledWith("recent", "book");
  });

  it("asks before restoring over another device's newer version", async () => {
    calls.restore.mockResolvedValueOnce("stale");
    const view = await mount(); await recents();
    await pickCopy(1);
    await press(byLabel(/^Hold to confirm: Restore copy 1 of Book\.pdf$/)!, true);
    expect(view.onChoose).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Changed on another device"]')).not.toBeNull();
    await press(byLabel(/^Hold to confirm: Restore anyway$|^Restore anyway$/)!, true);
    expect(calls.restore).toHaveBeenLastCalledWith(expect.objectContaining({ id: "c1" }), true);
    expect(view.onChoose).toHaveBeenCalledWith("recent", "book");
  });

  it("trashes only the picked copy, marks it (!), and the next hold deletes only it for good", async () => {
    await mount(); await recents();
    calls.trashCopy.mockImplementationOnce(async () => {
      store.versions = new Map([["book", [version("c1", "book", 1), version("c2", "book", 2, { trashedAt: 9 })]]]);
    });
    await pickCopy(2);
    await press(byLabel(/Move copy 2 of Book\.pdf to the trash/)!, true);
    expect(calls.trashCopy).toHaveBeenCalledWith("c2");
    expect(calls.deleteDoc).not.toHaveBeenCalled();
    // Still showing copy 2, now marked as in the trash.
    expect(byLabel(/Choose a version/)!.textContent).toContain("(!)");
    expect(row().classList.contains("is-trashed-copy")).toBe(true);
    await press(byLabel(/Delete copy 2 of Book\.pdf for good/)!, true);
    expect(calls.deleteCopies).toHaveBeenCalledWith(["c2"]);
    expect(calls.deleteDoc).not.toHaveBeenCalled();
  });

  it("exports what the row shows: tap for the annotated document, hold for the backup file", async () => {
    const view = await mount(); await recents();
    await press(byLabel(/^Export Book\.pdf: tap/)!, false);
    expect(view.onExportVersion).toHaveBeenCalledWith("book", null);
    await pickCopy(1);
    await press(byLabel(/^Export copy 1 of Book\.pdf: tap/)!, false);
    expect(view.onExportVersion).toHaveBeenLastCalledWith("book", "c1");
    await press(byLabel(/^Export copy 1 of Book\.pdf: tap/)!, true);
    expect(calls.backup).toHaveBeenCalledWith("annotate", "book", "Book.pdf", expect.objectContaining({ id: "c1" }));
    expect(view.onNotice).toHaveBeenCalledWith("Saved Book-copy-1-backup.json");
  });

  it("deletes a trashed book for good with all its copies, and says what goes with it", async () => {
    live.rows = []; live.trash = [{ id: "book", name: "Book.pdf", hash: "binnew-0", docType: "pdf", updatedAt: 5, deletedAt: 6 }];
    await mount(); await recents();
    const trashRow = [...document.querySelectorAll(".lc-library-trash-section .lc-scratch-load-entry")][0]!;
    expect(trashRow.textContent).toContain("2 retained copies");
    await act(async () => { trashRow.querySelector<HTMLButtonElement>(".lc-scratch-load-lock")!.click(); });
    await press(byLabel(/^Hold to confirm: Permanently delete Book\.pdf$|^Permanently delete Book\.pdf$/)!, true);
    expect(calls.deleteDoc).toHaveBeenCalledWith("book", true);
    expect(calls.deleteBookCopies).toHaveBeenCalledWith("annotate", "book");
  });

  it("lists copies whose book is gone in the trash, to restore or delete", async () => {
    store.versions = new Map([["gone", [version("g1", "gone", 1, { name: "Gone.pdf" })]]]);
    const view = await mount(); await recents();
    const orphan = [...document.querySelectorAll(".lc-library-trash-section .lc-scratch-load-entry")].find(node => node.textContent?.includes("Gone.pdf"))!;
    expect(orphan.textContent).toContain("Only retained copies");
    await press(byLabel(/^Hold to confirm: Restore Gone\.pdf$|^Restore Gone\.pdf$/)!, true);
    expect(calls.restore).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }), false);
    expect(view.onChoose).toHaveBeenCalledWith("recent", "gone");
  });
});
