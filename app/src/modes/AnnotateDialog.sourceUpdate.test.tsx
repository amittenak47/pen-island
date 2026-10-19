/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotateDocMeta } from "../util/annotateStore";

const library = vi.hoisted(() => ({ rows: [] as AnnotateDocMeta[] }));
const source = vi.hoisted(() => ({ refs: {} as Record<string, { name: string }>, check: vi.fn(), update: vi.fn(), link: vi.fn(), justLink: vi.fn() }));
const native = vi.hoisted(() => ({ available: vi.fn(), pickFolder: vi.fn(), listFolder: vi.fn(), stat: vi.fn() }));

vi.mock("../components/HoldButton", () => ({
  HoldButton: ({ label, children, onConfirm, disabled, className }: {
    label: string; children?: ReactNode; onConfirm: () => void; disabled?: boolean; className?: string;
  }) => <button type="button" aria-label={label} className={className} disabled={disabled} onClick={onConfirm}>{children ?? label}</button>,
}));
vi.mock("../util/annotateStore", () => ({
  ANNOTATE_LIBRARY_EVENT: "lc-annotate-library",
  listAnnotateDocs: () => library.rows,
  listAnnotateTrash: () => [],
  trashAnnotateDoc: vi.fn(), deleteAnnotateDoc: vi.fn(), setAnnotateDocLocked: vi.fn(),
  annotateDocLabel: (doc: AnnotateDocMeta) => doc.label?.trim() || doc.name,
}));
vi.mock("../util/docSourceStore", () => ({ listDocSources: () => source.refs, getDocSource: (id: string) => source.refs[id] ?? null }));
vi.mock("../util/docSourceUpdate", () => ({ checkDocSource: source.check, updateDocFromSource: source.update, linkDocSource: source.link, justLinkDocSource: source.justLink, DOC_SOURCE_CHECKED_EVENT: "lc-doc-source-checked" }));
vi.mock("../util/docSourceNative", () => ({ nativeSourcePickerAvailable: native.available, pickSourceFolder: native.pickFolder, listSourceFolder: native.listFolder, statDocumentSource: native.stat }));
vi.mock("../util/padSnapshotStore", () => ({ listPadSnapshots: async () => [], PAD_SNAPSHOT_TIERS: [] }));
vi.mock("../util/padSync", () => ({ TOMBSTONE_COPY: "Trash on this device." }));
vi.mock("./RetainedCopies", () => ({ RetainedCopies: () => null }));

import { AnnotateDialog } from "./AnnotateDialog";

let host: HTMLDivElement;
let root: Root;
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  source.check.mockReset(); source.update.mockReset();
  source.link.mockReset(); source.justLink.mockReset();
  native.available.mockReset().mockReturnValue(false); native.pickFolder.mockReset(); native.listFolder.mockReset(); native.stat.mockReset();
  library.rows = [
    { id: "first", name: "Lecture.pdf", hash: "old-1", docType: "pdf", updatedAt: 1 },
    { id: "second", name: "Notes.md", hash: "old-2", docType: "markdown", updatedAt: 2 },
  ];
  source.refs = { first: { name: "Lecture.pdf" }, second: { name: "Notes.md" } };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function mount(onNotice?: (message: string) => void) {
  act(() => root.render(<AnnotateDialog mode="entry" onChoose={vi.fn()} onCancel={vi.fn()} onNotice={onNotice} />));
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(node => node.getAttribute("aria-label") === label || node.textContent?.trim() === label);
  expect(button, `missing button ${label}`).toBeTruthy();
  await act(async () => button!.click());
}
async function recents() { await click("Open"); await click("Recents"); }

describe("AnnotateDialog source updates", () => {
  it("lists folder matches, links only selected files, and offers differing files in the newer list", async () => {
    library.rows.push(
      { id: "third", name: "Chapter.md", hash: "old-3", docType: "markdown", updatedAt: 3 },
      { id: "fourth", name: "Appendix.md", hash: "old-4", docType: "markdown", updatedAt: 4 },
    );
    source.refs = {};
    const folder = { kind: "path", location: "C:/course", name: "course" };
    const entries = library.rows.map(doc => ({ kind: "path", location: `C:/course/${doc.name}`, name: doc.name, relative: `notes/${doc.name}`, size: 10, modified: 1 }));
    const content = (id: string) => ({ status: "newer", text: `changed ${id}`, ref: { hash: `new-${id}` } });
    native.available.mockReturnValue(true); native.pickFolder.mockResolvedValue(folder); native.listFolder.mockResolvedValue(entries);
    source.link.mockImplementation(async (id: string) => id === "first" ? { status: "linked" } : { status: "differs", content: content(id) });
    source.update.mockResolvedValue({ unplaced: [{ kind: "highlight", label: "A passage" }] });
    const notice = vi.fn(); mount(notice); await recents();
    // The chain alone, named by its label.
    const folder = host.querySelector<HTMLButtonElement>(".lc-doc-source-folder")!;
    expect(folder.textContent).toBe(""); expect(folder.querySelector("svg")).not.toBeNull();
    expect(folder.getAttribute("aria-label")).toBe("Link files from a folder…");
    await click("Link files from a folder…");
    expect(native.listFolder).toHaveBeenCalledWith("path", "C:/course");
    const dialog = host.querySelector<HTMLElement>('[aria-label="Link files"]')!;
    expect(dialog.textContent).toContain("notes/Chapter.md");
    const boxes = dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect([...boxes].every(box => box.checked)).toBe(true);
    await act(async () => boxes[1]!.click());
    await click("Link selected");
    expect(source.link.mock.calls.map(call => call[0])).toEqual(["first", "third", "fourth"]);
    expect(source.link).toHaveBeenCalledWith("third", entries[2]);
    const newer = host.querySelector<HTMLElement>('[aria-label="Newer versions available"]')!;
    const updates = newer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(updates).toHaveLength(2); expect([...updates].every(box => box.checked)).toBe(true);
    await act(async () => updates[1]!.click());
    await click("Update selected");
    expect(source.update).toHaveBeenCalledTimes(1);
    expect(source.update).toHaveBeenCalledWith("third", content("third"));
    expect(source.justLink).toHaveBeenCalledTimes(1);
    expect(source.justLink).toHaveBeenCalledWith("fourth", content("fourth").ref);
    expect(notice).toHaveBeenCalledWith("Linked 3 documents. 1 was updated. 1 annotation couldn't be placed and stays in the previous version (Recents → retained copies).");
  });

  it("reports duplicate names in the folder dialog and announces no matches", async () => {
    source.refs = {};
    native.available.mockReturnValue(true); native.pickFolder.mockResolvedValue({ kind: "uri", location: "content://tree", name: "course" });
    const file = (name: string, relative: string) => ({ kind: "uri", location: `content://tree/${relative}`, name, relative, size: null, modified: null });
    native.listFolder.mockResolvedValue([file("Notes.md", "one/Notes.md"), file("NOTES.MD", "two/NOTES.MD"), file("Lecture.pdf", "Lecture.pdf")]);
    mount(); await recents(); await click("Link files from a folder…");
    const dialog = host.querySelector<HTMLElement>('[aria-label="Link files"]')!;
    expect(dialog.textContent).toContain("1 name appears more than once and was skipped");
    expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close Link files"]')!.click());
    native.listFolder.mockResolvedValue([]);
    await click("Link files from a folder…");
    expect(host.textContent).toContain("No documents in this folder match your library.");
  });

  it("leaves the library alone when the folder picker is cancelled", async () => {
    native.available.mockReturnValue(true); native.pickFolder.mockResolvedValue(null);
    mount(); await recents(); await click("Link files from a folder…");
    expect(native.listFolder).not.toHaveBeenCalled(); expect(source.link).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Link files"]')).toBeNull();
  });

  it("lists newer files checked by default and updates only the selected file", async () => {
    const newer = (id: string) => ({ status: "newer", text: `new ${id}`, ref: { hash: `new-${id}` } });
    source.check.mockImplementation(async (id: string) => newer(id));
    source.update.mockResolvedValue({ unplaced: [{ kind: "ink", label: "Page 3" }] });
    const notice = vi.fn();
    mount(notice); await recents();
    // First in the footer, now that Pull is gone from the menus.
    expect(host.querySelector(".lc-dialog-foot")?.firstElementChild?.textContent).toContain("Check for newer versions");
    await click("Check for newer versions");
    expect(source.check.mock.calls.map(call => call[0])).toEqual(["first", "second"]);
    const dialog = host.querySelector<HTMLElement>('[aria-label="Newer versions available"]')!;
    expect(dialog.textContent).toContain("Lecture.pdf"); expect(dialog.textContent).toContain("Notes.md");
    const boxes = dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect([...boxes].every(box => box.checked)).toBe(true);
    await act(async () => boxes[1]!.click());
    await click("Update selected");
    expect(source.update).toHaveBeenCalledTimes(1);
    expect(source.update).toHaveBeenCalledWith("first", newer("first"));
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("Updated 1 document."));
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("1 annotation couldn't be placed"));
  });

  it("checks at most three files at once, then updates one at a time with progress", async () => {
    library.rows = Array.from({ length: 5 }, (_, index) => ({ id: `d${index}`, name: `File ${index}.md`, hash: `h${index}`, docType: "markdown", updatedAt: index }));
    source.refs = Object.fromEntries(library.rows.map(doc => [doc.id, { name: doc.name }]));
    const completeChecks: (() => void)[] = [];
    source.check.mockImplementation((id: string) => new Promise(resolve => completeChecks.push(() => resolve({ status: "newer", text: id }))));
    mount(); await recents(); await click("Check for newer versions");
    expect(source.check).toHaveBeenCalledTimes(3);
    expect(host.textContent).toContain("Checking 0 of 5 files");
    await act(async () => completeChecks[0]!());
    expect(source.check).toHaveBeenCalledTimes(4);
    await act(async () => { completeChecks[1]!(); completeChecks[2]!(); });
    expect(source.check).toHaveBeenCalledTimes(5);
    await act(async () => { completeChecks[3]!(); completeChecks[4]!(); });
    const completeUpdates: (() => void)[] = [];
    source.update.mockImplementation(() => new Promise(resolve => completeUpdates.push(() => resolve({ unplaced: [] }))));
    await click("Update selected");
    expect(source.update).toHaveBeenCalledTimes(1); expect(host.textContent).toContain("Updating 1 of 5");
    for (let index = 0; index < 5; index++) {
      expect(source.update).toHaveBeenCalledTimes(index + 1);
      await act(async () => completeUpdates[index]!());
    }
    expect(host.textContent).toContain("Updated 5 documents.");
  });

  it("reports no newer versions and hides the command without a source", async () => {
    source.check.mockResolvedValue({ status: "same" });
    mount(); await recents(); await click("Check for newer versions");
    expect(host.textContent).toContain("Everything is up to date");
    source.refs = {};
    act(() => window.dispatchEvent(new Event("lc-annotate-library")));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    expect(host.querySelector(".lc-doc-source-bulk")).toBeNull();
  });

  it("continues after an update failure and reports it in the summary", async () => {
    source.check.mockResolvedValue({ status: "newer", text: "changed" });
    source.update.mockRejectedValueOnce(new Error("Backup could not be written")).mockResolvedValueOnce({ unplaced: [] });
    const notice = vi.fn(); mount(notice); await recents(); await click("Check for newer versions"); await click("Update selected");
    expect(source.update).toHaveBeenCalledTimes(2);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("1 update failed"));
    expect(host.textContent).toContain("Lecture.pdf: Backup could not be written");
  });

  it("publishes check results for reading-view dots even when cancelled, and keeps them on a check failure", async () => {
    const results: { id: string; newer: boolean }[] = [];
    const checked = (event: Event) => results.push((event as CustomEvent<{ id: string; newer: boolean }>).detail);
    window.addEventListener("lc-doc-source-checked", checked);
    try {
      source.check.mockImplementation(async (id: string) => ({ status: id === "first" ? "newer" : "same", text: "changed" }));
      mount(); await recents(); await click("Check for newer versions");
      expect(results).toEqual([{ id: "first", newer: true }, { id: "second", newer: false }]);
      const dialog = host.querySelector<HTMLElement>('[aria-label="Newer versions available"]')!;
      const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Cancel")!;
      await act(async () => cancel.click());
      expect(source.update).not.toHaveBeenCalled();
      source.check.mockRejectedValue(new Error("Source could not be read"));
      await click("Check for newer versions");
      expect(results).toHaveLength(2);
      expect(host.textContent).toContain("2 files couldn't be checked.");
    } finally { window.removeEventListener("lc-doc-source-checked", checked); }
  });
});
