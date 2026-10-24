/**
 * @vitest-environment jsdom
 */
import { resetLibraryDeleteArmForTests } from "../util/armedDelete";
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { LIBRARY_HOLD_MS } from "../util/gesture";
import type { AnnotateDocMeta } from "../util/annotateStore";

const live = vi.hoisted(() => ({ rows: [] as AnnotateDocMeta[] }));
const trash = vi.hoisted(() => ({ rows: [] as AnnotateDocMeta[] }));

vi.mock("../util/annotateStore", () => ({
  ANNOTATE_LIBRARY_EVENT: "lc-annotate-library",
  listAnnotateDocs: () => live.rows,
  listAnnotateTrash: () => trash.rows,
  trashAnnotateDoc: vi.fn(),
  setAnnotateDocLocked: vi.fn(),
  annotateDocLabel: (doc: AnnotateDocMeta) => doc.label?.trim() || doc.name,
}));

vi.mock("../util/padSnapshotStore", () => ({
  listPadSnapshots: async () => [],
  PAD_SNAPSHOT_TIERS: [],
}));

vi.mock("../util/padSync", () => ({
  TOMBSTONE_COPY: "Trash on this device — three days, then gone.",
}));

vi.mock("../util/docSourceStore", () => ({ listDocSources: () => ({}) }));
vi.mock("../util/docSourceUpdate", () => ({ checkDocSource: vi.fn(), updateDocFromSource: vi.fn(), DOC_SOURCE_CHECKED_EVENT: "lc-doc-source-checked" }));

import { AnnotateDialog, type AnnotateDialogProps } from "./AnnotateDialog";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
    Element.prototype.releasePointerCapture = function () {};
    Element.prototype.hasPointerCapture = function () {
      return true;
    };
  }
  if (typeof PointerEvent === "undefined") {
    class FakePointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    // @ts-expect-error jsdom lacks PointerEvent
    globalThis.PointerEvent = FakePointerEvent;
  }
});

beforeEach(() => {
  live.rows = [
    { id: "d1", name: "note.md", hash: "h1", docType: "markdown", updatedAt: 1 },
    { id: "w1", name: "https://example.com/", hash: "h2", docType: "web", updatedAt: 2, label: "Example" },
  ];
  trash.rows = [];
});

afterEach(() => {
  vi.useRealTimers();
});

function mount(props: Partial<Extract<AnnotateDialogProps, { mode: "entry" }>> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  act(() => {
    root.render(
      <AnnotateDialog mode="entry" onChoose={onChoose} onCancel={onCancel} {...props} />,
    );
  });
  return {
    host,
    onChoose,
    onCancel,
    unmount: () => act(() => root.unmount()),
  };
}

function fill(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(label: string, host: HTMLElement) {
  if ((label === "Recent" || label === "Load") && host.querySelector('[aria-label="Hold to confirm: Open"]')) await click("Open", host);
  const button=Array.from(host.querySelectorAll("button")).find(node=>node.textContent?.trim().startsWith(label));
  expect(button, `missing button ${label}`).toBeTruthy();
  if (button!.getAttribute("aria-label")?.startsWith("Hold to confirm")) {
    await act(async () => {
      button!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, LIBRARY_HOLD_MS + 50));
      button!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
    });
    return;
  }
  await act(async()=>button!.click());
}

async function hold(label: string, host: HTMLElement) {
  const aria = `Hold to confirm: ${label}`;
  const button = Array.from(host.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === aria,
  );
  expect(button, `missing hold button "${aria}"`).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, LIBRARY_HOLD_MS + 50));
  });
}

async function tap(label: string, host: HTMLElement) {
  const aria = `${label}: tap to edit, hold to confirm`;
  const button = Array.from(host.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === aria,
  );
  expect(button, `missing tap button "${aria}"`).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
    button!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
  });
}

describe("AnnotateDialog", () => {
  it("asks before deleting a document changed on another device; Delete anyway forces it", async () => {
    // Another device changes this book; delete is refused, the reader is asked, Delete anyway forces it.
    const onDelete = vi.fn(async (id: string, options?: { force?: boolean }) => {
      if (!options?.force) return { status: "stale" as const };
      const at = live.rows.findIndex(row => row.id === id); trash.rows.push({ ...live.rows[at]!, deletedAt: 1 }); live.rows.splice(at, 1);
      return { status: "deleted" as const };
    });
    const view = mount({ onDelete: onDelete as unknown as Extract<AnnotateDialogProps, { mode: "entry" }>["onDelete"] });
    try {
      await click("Recent", view.host);
      const remove = view.host.querySelector<HTMLButtonElement>(".lc-scratch-load-trash")!;
      await act(async () => {
        remove.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
        await new Promise(resolve => setTimeout(resolve, LIBRARY_HOLD_MS + 50));
        remove.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
      });
      await hold("Delete", view.host);
      expect(onDelete).toHaveBeenCalledTimes(1); expect(onDelete.mock.calls[0]![1]?.force).toBeFalsy();
      expect(view.host.textContent).toContain("Changed on another device");
      expect(view.host.textContent).toContain("It changed since your last sync. Delete anyway?");
      expect(live.rows.some(row => row.id === "d1")).toBe(true);
      await hold("Delete anyway", view.host);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(onDelete).toHaveBeenLastCalledWith("d1", { force: true });
      expect(live.rows.some(row => row.id === "d1")).toBe(false);
      expect(view.host.querySelector('[aria-label="Changed on another device"]:not([inert])')).toBeNull();
    } finally { view.unmount(); view.host.remove(); resetLibraryDeleteArmForTests(); }
  });
  it("Cancel on the changed-elsewhere prompt keeps the document and sends nothing more", async () => {
    const onDelete = vi.fn(async () => ({ status: "stale" as const }));
    const view = mount({ onDelete: onDelete as unknown as Extract<AnnotateDialogProps, { mode: "entry" }>["onDelete"] });
    try {
      await click("Recent", view.host);
      const remove = view.host.querySelector<HTMLButtonElement>(".lc-scratch-load-trash")!;
      await act(async () => {
        remove.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
        await new Promise(resolve => setTimeout(resolve, LIBRARY_HOLD_MS + 50));
        remove.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
      });
      await hold("Delete", view.host);
      expect(view.host.textContent).toContain("It changed since your last sync. Delete anyway?");
      const cancel = Array.from(view.host.querySelectorAll<HTMLButtonElement>(".lc-confirm-dialog button, [role=alertdialog] button, [role=dialog] button"))
        .filter(button => button.textContent?.trim() === "Cancel").pop()!;
      await act(async () => { cancel.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(live.rows.some(row => row.id === "d1")).toBe(true);
      expect(view.host.querySelector('[aria-label="Changed on another device"]:not([inert])')).toBeNull();
    } finally { view.unmount(); view.host.remove(); }
  });
  it("keeps New and the existing note naming and creation flow", async () => {
    const view = mount();
    try {
      expect(view.host.querySelector('[data-dialog-shape="blocky"]')).toBeTruthy();
      expect(view.host.querySelector('[aria-label="Hold to confirm: More"]')).toBeNull();
      expect(view.host.querySelector('.lc-dialog-foot')?.textContent?.trim()).toBe("Cancel");
      await click("New", view.host);await click("Markdown file", view.host);
      await act(async () => fill(view.host.querySelector('.lc-md-new-title input')!, "Draft note"));
      await hold("Create note", view.host);
      expect(view.onChoose).toHaveBeenLastCalledWith("new", "Draft note");
    } finally { view.unmount(); }
  });

  it.each(["pdf", "markdown", "epub"])("preserves the %s export choices and save operation", async (docType) => {
    const view = mount({allowSave:true, snapshotKey:"d1", docType, docName:"Current file"});
    try {
      await hold("Save", view.host);expect(view.onChoose).toHaveBeenLastCalledWith("save");
      await click("Export", view.host);
      await hold("PDF", view.host);expect(view.onChoose).toHaveBeenLastCalledWith("export-pdf");
      await hold("Annotation backup", view.host);expect(view.onChoose).toHaveBeenLastCalledWith("export");
      if(docType === "pdf")expect(view.host.querySelector('[aria-label="Hold to confirm: Markdown + images (ZIP)"]')).toBeNull();
      else {await hold(docType === "epub" ? "EPUB" : "Markdown + images (ZIP)", view.host);expect(view.onChoose).toHaveBeenLastCalledWith("export-document");}
    } finally {view.unmount();}
  }, 10000);

  it("keeps Web Save and its naming step", async () => {
    const view = mount({kind:"web", allowSave:true, snapshotKey:"w1", docType:"web", needsName:true, defaultName:"Page notes"});
    try {
      expect(view.host.querySelector('[aria-label="Hold to confirm: Save"]')).toBeTruthy();
      expect(view.host.textContent).toContain("Start a blank page");
      await hold("New",view.host);expect(view.onChoose).toHaveBeenLastCalledWith("page");
      await hold("Save", view.host);
      await act(async () => fill(view.host.querySelector('.lc-md-new-title input')!, "Named page"));
      await hold("Save", view.host);expect(view.onChoose).toHaveBeenLastCalledWith("save", "Named page");
    } finally {view.unmount();}
  });

  it("puts the tab's [Sync | Link] beside the document name, and no Pull or context on a Web entry", async () => {
    const onSync=vi.fn(), onCheck=vi.fn();
    const pair={syncLine:"Not synced",syncing:false,onSync,link:{name:"Lecture.pdf",checking:false,newer:false,onCheck,onLink:vi.fn(),onUnlink:vi.fn()}};
    const view=mount({allowSave:true,snapshotKey:"d1",syncPair:pair});
    expect(view.host.querySelector('.lc-annotate-context-sync')).toBeNull();
    const halves=view.host.querySelectorAll<HTMLButtonElement>('.lc-annotate-context .lc-sync-link-pair button');
    expect([...halves].map(b=>b.className.match(/lc-sync-link-(sync|link)/)?.[1])).toEqual(["sync","link"]);
    act(()=>halves[0].click());
    expect(onSync).toHaveBeenCalledOnce();
    expect(view.host.textContent).not.toContain("Pull");
    view.unmount();
    const web=mount({kind:"web",allowSave:true,snapshotKey:"d1",docType:"pdf",docName:"Wrong PDF",syncPair:pair});
    expect(web.host.querySelector('.lc-annotate-context')).toBeNull();web.unmount();
  });

  it("locks the Sync pair, header close and menu rows during an operation", () => {
    const onSync=vi.fn();
    const view=mount({pending:true,allowSave:true,snapshotKey:"d1",syncPair:{syncLine:null,syncing:false,onSync,link:null}});
    expect(view.host.querySelector('.lc-sync-link-pair')).not.toBeNull();
    expect([...view.host.querySelectorAll('button')].every(b=>b.disabled)).toBe(true);
    view.unmount();
  });

  it("only offers annotation import for an open file", async () => {
    const closed=mount();
    expect(closed.host.textContent).not.toContain("Annotations");
    expect(closed.host.textContent).not.toContain("Import");
    await click("Load",closed.host);
    expect(closed.onChoose).toHaveBeenLastCalledWith("open");
    closed.unmount();
    const opened=mount({allowSave:true,snapshotKey:"d1"});
    await click("Open",opened.host);await click("Annotations",opened.host);await click("Import",opened.host);
    expect(opened.onChoose).toHaveBeenLastCalledWith("import");
    opened.unmount();
  });
  it("offers the Web pad Open with Load and Recents, without annotation sets", async () => {
    const view=mount({kind:"web",allowSave:true,snapshotKey:"w1",docType:"web"});
    await click("Open",view.host);
    expect(view.host.textContent).toContain("Recents");
    expect(view.host.textContent).not.toContain("Annotations");
    await click("Load",view.host);
    expect(view.onChoose).toHaveBeenLastCalledWith("open");
    view.unmount();
  });
  it("filters saved files by filename or annotation-set name", async () => {
    live.rows.push({id:"d2",name:"book.pdf",label:"Exam notes",hash:"h3",docType:"pdf",updatedAt:3});
    const view=mount();
    try {
      await click("Recent",view.host);
      await act(async()=>fill(view.host.querySelector('input[type="search"]')!,"EXAM"));
      expect(view.host.querySelectorAll('.lc-scratch-load-entry')).toHaveLength(1);
      expect(view.host.querySelector('.lc-scratch-load-entry')?.textContent).toContain("book.pdf");
      await hold("Open Exam notes",view.host);
      expect(view.onChoose).toHaveBeenLastCalledWith("recent","d2");
    } finally {view.unmount();}
  });
  it("keeps exports distinct from backups and filters annotation sets to this file", async () => {
    live.rows.push({id:"d2",name:"note.md",hash:"h1",docType:"markdown",updatedAt:2,label:"Second set"});
    live.rows.push({id:"other",name:"other.pdf",hash:"other",docType:"pdf",updatedAt:3});
    const view=mount({allowSave:true,snapshotKey:"d1"});
    expect(view.host.textContent).not.toContain("Import annotation backup");
    await click("Export",view.host);await click("PDF",view.host);expect(view.onChoose).toHaveBeenLastCalledWith("export-pdf");
    await click("Markdown + images (ZIP)",view.host);expect(view.onChoose).toHaveBeenLastCalledWith("export-document");
    await click("Back",view.host);await click("Open",view.host);
    await click("Annotations",view.host);await click("Saved",view.host);
    expect(view.host.textContent).toContain("Second set");expect(view.host.textContent).not.toContain("other.pdf");
    await click("Back",view.host);await click("Back",view.host);await click("Back",view.host);await click("Export",view.host);await click("Annotation backup",view.host);
    expect(view.onChoose).toHaveBeenLastCalledWith("export");
    view.unmount();
  }, 20000);
  it("closes confirmation and updates live/Trash as soon as local deletion commits", async () => {
    let finish!: () => void;
    const syncing = new Promise<void>((resolve) => { finish = resolve; });
    const onDelete = vi.fn(async (id: string) => {
      const row = live.rows.find((entry) => entry.id === id)!;
      live.rows = live.rows.filter((entry) => entry.id !== id);
      trash.rows = [{ ...row, deletedAt: 2 }];
      window.dispatchEvent(new Event("lc-annotate-library"));
      await syncing;
    });
    const view = mount({ onDelete });
    await click("Recent", view.host);
    const remove = view.host.querySelector<HTMLButtonElement>(".lc-scratch-load-trash")!;
    expect(remove).toBeTruthy();
    await act(async () => {
      remove.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, LIBRARY_HOLD_MS + 50));
      remove.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
    });
    expect(view.host.textContent).toContain("Remove this document?");
    await hold("Delete", view.host);
    expect(onDelete).toHaveBeenCalledWith("d1");
    expect(view.host.querySelector('[aria-label="Remove this document?"]:not([inert])')).toBeNull();
    expect(view.host.querySelector('[aria-label="Open note.md: tap to edit, hold to confirm"]')).toBeNull();
    await act(async()=>view.host.querySelector<HTMLButtonElement>('[aria-label="Trash"]')!.click());
    expect(view.host.textContent).toContain("Restore · note.md");
    await act(async () => { finish(); await syncing; });
    view.unmount();
  });

  it("keeps web pads out of the document Recent list", async () => {
    const view = mount({ kind: "document" });
    await click("Recent", view.host);
    expect(view.host.textContent).toContain("note.md");
    expect(view.host.textContent).not.toContain("Example");
    expect(view.host.textContent).not.toContain("https://example.com/");
    view.unmount();
  });

  it("lists only web pads in the Pages Recent list", async () => {
    const view = mount({ kind: "web" });
    await click("Recent", view.host);
    expect(view.host.textContent).toContain("Example");
    expect(view.host.textContent).not.toContain("note.md");
    view.unmount();
  });

  it("searches live and trash together, then intersects Trash with query and type filters", async () => {
    live.rows.push({id:"d2",name:"exam.md",hash:"h3",docType:"markdown",updatedAt:3});
    trash.rows = [
      {id:"t1",name:"exam.pdf",hash:"h4",docType:"pdf",updatedAt:1,deletedAt:2},
      {id:"t2",name:"exam.md",hash:"h5",docType:"markdown",updatedAt:1,deletedAt:2},
    ];
    const view=mount();
    try {
      await click("Recent",view.host);
      const section=view.host.querySelector('section[aria-label="Trash"]')!;
      expect(section.querySelectorAll('.lc-scratch-load-entry')).toHaveLength(2);
      await act(async()=>fill(view.host.querySelector('input[type="search"]')!,"exam"));
      expect(view.host.querySelectorAll('.lc-scratch-load-entry')).toHaveLength(3);
      await act(async()=>view.host.querySelector<HTMLButtonElement>('[aria-label="Trash"]')!.click());
      expect(view.host.querySelectorAll('.lc-scratch-load-entry')).toHaveLength(2);
      await act(async()=>view.host.querySelector<HTMLButtonElement>('[aria-label="Filter pdf"]')!.click());
      expect(view.host.querySelectorAll('.lc-scratch-load-entry')).toHaveLength(1);
      expect(section.textContent).toContain("exam.pdf");
      await act(async()=>view.host.querySelector<HTMLButtonElement>('[aria-label="Filter markdown"]')!.click());
      expect(view.host.querySelectorAll('.lc-scratch-load-entry')).toHaveLength(2);
      await act(async()=>fill(view.host.querySelector('input[type="search"]')!,"missing"));
      expect(view.host.querySelectorAll('.lc-scratch-load-entry')).toHaveLength(0);
      expect(view.host.textContent).toContain("No matching saved items.");
    } finally {view.unmount();view.host.remove();}
  });

  it("moves a restored row from trash to live without remounting", async () => {
    live.rows = [];
    trash.rows = [
      { id: "d1", name: "note.md", hash: "h1", docType: "markdown", updatedAt: 1, deletedAt: 2 },
    ];
    const onRestoreTrash = vi.fn(async (id: string) => {
      const row = trash.rows.find((entry) => entry.id === id);
      trash.rows = trash.rows.filter((entry) => entry.id !== id);
      if (row) {
        const { deletedAt: _deletedAt, ...rest } = row;
        live.rows = [rest];
      }
    });
    const view = mount({ kind: "document", onRestoreTrash });
    await click("Recent", view.host);
    await act(async()=>view.host.querySelector<HTMLButtonElement>('[aria-label="Trash"]')!.click());
    expect(view.host.textContent).toContain("Restore · note.md");
    await hold("Restore note.md", view.host);
    await act(async()=>view.host.querySelector<HTMLButtonElement>('[aria-label="Trash"]')!.click());
    expect(onRestoreTrash).toHaveBeenCalledWith("d1");
    expect(view.host.textContent).toContain("note.md");
    expect(view.host.textContent).not.toContain("Restore · note.md");
    view.unmount();
  });

  it("renames a recent row on double-tap", async () => {
    const onRename = vi.fn(async (id: string, title: string) => {
      live.rows = live.rows.map((row) => (row.id === id ? { ...row, label: title } : row));
    });
    const view = mount({ kind: "document", onRename });
    await click("Recent", view.host);
    await tap("Open note.md", view.host);
    await tap("Open note.md", view.host);
    const input = view.host.querySelector<HTMLInputElement>(".lc-md-new-title input");
    expect(input).not.toBeNull();
    await act(async () => {
      fill(input!, "Lecture notes");
    });
    await act(async () => {
      input!.blur();
    });
    expect(onRename).toHaveBeenCalledWith("d1", "Lecture notes");
    expect(view.host.textContent).toContain("Lecture notes");
    view.unmount();
  });
});
