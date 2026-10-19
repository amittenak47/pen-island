/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotateDocMeta } from "../util/annotateStore";

const library = vi.hoisted(() => ({ rows: [] as AnnotateDocMeta[] }));
const source = vi.hoisted(() => ({ refs: {} as Record<string, { name: string }>, check: vi.fn(), update: vi.fn() }));

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
vi.mock("../util/docSourceStore", () => ({ listDocSources: () => source.refs }));
vi.mock("../util/docSourceUpdate", () => ({ checkDocSource: source.check, updateDocFromSource: source.update, DOC_SOURCE_CHECKED_EVENT: "lc-doc-source-checked" }));
vi.mock("../util/padSnapshotStore", () => ({ listPadSnapshots: async () => [], PAD_SNAPSHOT_TIERS: [] }));
vi.mock("../util/padSync", () => ({ TOMBSTONE_COPY: "Trash on this device." }));
vi.mock("./RetainedCopies", () => ({ RetainedCopies: () => null }));

import { AnnotateDialog } from "./AnnotateDialog";

let host: HTMLDivElement;
let root: Root;
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  source.check.mockReset(); source.update.mockReset();
  library.rows = [
    { id: "first", name: "Lecture.pdf", hash: "old-1", docType: "pdf", updatedAt: 1 },
    { id: "second", name: "Notes.md", hash: "old-2", docType: "markdown", updatedAt: 2 },
  ];
  source.refs = { first: { name: "Lecture.pdf" }, second: { name: "Notes.md" } };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function mount(onNotice?: (message: string) => void) {
  act(() => root.render(<AnnotateDialog mode="entry" onChoose={vi.fn()} onCancel={vi.fn()} onNotice={onNotice} onRefreshHub={async () => 0} />));
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(node => node.getAttribute("aria-label") === label || node.textContent?.trim() === label);
  expect(button, `missing button ${label}`).toBeTruthy();
  await act(async () => button!.click());
}
async function recents() { await click("Open"); await click("Recents"); }

describe("AnnotateDialog source updates", () => {
  it("lists newer files checked by default and updates only the selected file", async () => {
    const newer = (id: string) => ({ status: "newer", text: `new ${id}`, ref: { hash: `new-${id}` } });
    source.check.mockImplementation(async (id: string) => newer(id));
    source.update.mockResolvedValue({ unplaced: [{ kind: "ink", label: "Page 3" }] });
    const notice = vi.fn();
    mount(notice); await recents();
    expect(host.querySelector(".lc-library-footer-pull")?.nextElementSibling?.textContent).toContain("Check for newer versions");
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
