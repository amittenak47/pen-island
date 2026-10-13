/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FootnoteNoteWorkspace, footnoteNoteTab } from "./FootnoteNoteWorkspace";
import { ANNOTATE_LIBRARY_EVENT, type AnnotateDoc } from "../util/annotateStore";
import { footnoteThemeVars } from "../util/footnoteTheme";
import type { AnnotateTab, FootnoteNoteRef } from "../util/tabs";
import { takeMiniNoteRestore } from "../util/miniNoteWindows";

const mocks = vi.hoisted(() => ({
  read: vi.fn(), shell: {
    setChrome: vi.fn(), setWorkspaceApi: vi.fn(), setShellLoadActive: vi.fn(), takeUserLoad: vi.fn(),
    setBrowseMotion: vi.fn(), setHoldBrowseOverlay: vi.fn(), openWorkspace: vi.fn(), closeTab: vi.fn(),
    patchTab: vi.fn(), setError: vi.fn(),
  },
}));
vi.mock("../shellContext", async importOriginal => ({
  ...await importOriginal<typeof import("../shellContext")>(), useShell: () => mocks.shell,
}));
vi.mock("../util/annotateStore", async importOriginal => ({
  ...await importOriginal<typeof import("../util/annotateStore")>(), getAnnotateDoc: mocks.read,
}));

const ref: FootnoteNoteRef = { docId: "scratch", footnoteId: "f1", noteId: "n1" };
const record = {
  id: "scratch", hash: "hash", name: "scratch.md", docType: "markdown", updatedAt: 1,
  footnotes: [{ id: "f1", kind: "ai", anchor: { kind: "text", start: 0, end: 4 }, excerpt: "Test", createdAt: 1,
    color: "#0d9488", palette: ["#0d9488", "#115e59", "#5eead4", "#ccfbf1"],
    notes: [{ id: "n1", text: "**Original note**", createdAt: 1, updatedAt: 1 }] }],
} as AnnotateDoc;
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue(record); });
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.textContent = ""; });
function mount() {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const tab = footnoteNoteTab(ref, "Note 1.1") as AnnotateTab & { footnoteNote: FootnoteNoteRef };
  act(() => root!.render(<FootnoteNoteWorkspace tab={tab} active showing />));
  return tab;
}

describe("full footnote note tabs", () => {
  it("reads the parent note, uses the parent's colors, and clears the loading lap", async () => {
    const tab = mount();
    await vi.waitFor(() => expect(document.querySelector('.lc-footnote-note-body strong')?.textContent).toBe("Original note"));
    expect(mocks.read).toHaveBeenCalledWith("scratch");
    expect(tab.source).toBeNull();
    const theme = footnoteThemeVars(record.footnotes![0]!.color, record.footnotes![0]!.palette!);
    const reader = document.querySelector<HTMLElement>('.lc-footnote-note-workspace')!;
    for (const key of ["--lc-fn-color", "--lc-fn-wash", "--lc-fn-ink"]) {
      expect(reader.style.getPropertyValue(key)).toBe((theme as Record<string, string>)[key]);
    }
    await vi.waitFor(() => expect(mocks.shell.setShellLoadActive).toHaveBeenCalledWith(false));
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close note tab"]')!.click());
    expect(mocks.shell.closeTab).toHaveBeenCalledWith(tab.id);
  });

  it("refreshes from the same parent after a saved note changes", async () => {
    mount();
    await vi.waitFor(() => expect(document.querySelector('.lc-footnote-note-body')?.textContent).toContain("Original note"));
    mocks.read.mockResolvedValue({ ...record, footnotes: [{ ...record.footnotes![0],
      notes: [{ id: "n1", text: "Updated original", createdAt: 1, updatedAt: 2 }] }] });
    act(() => window.dispatchEvent(new Event(ANNOTATE_LIBRARY_EVENT)));
    await vi.waitFor(() => expect(document.querySelector('.lc-footnote-note-body')?.textContent?.trim()).toBe("Updated original"));
    expect(mocks.read.mock.calls.every(args => args[0] === "scratch")).toBe(true);
  });

  it("reports a removed note without creating replacement text", async () => {
    mocks.read.mockResolvedValue({ ...record, footnotes: [] });
    mount();
    await vi.waitFor(() => expect(document.body.textContent).toContain("This note is no longer in its footnote"));
    expect(document.querySelector('.lc-footnote-note-body')).toBeNull();
    expect(mocks.shell.setShellLoadActive).toHaveBeenCalledWith(false);
  });

  it("restores the mini on its parent document and closes the full note tab", async () => {
    const tab = mount();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Restore mini note"]')).not.toBeNull());
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Restore mini note"]')!.click());
    expect(mocks.shell.openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ docId: "scratch", docType: "markdown" }));
    expect(mocks.shell.openWorkspace.mock.calls.at(-1)![0].footnoteNote).toBeUndefined();
    expect(takeMiniNoteRestore("scratch")).toEqual(ref);
    expect(mocks.shell.closeTab).toHaveBeenCalledWith(tab.id);
  });
});
