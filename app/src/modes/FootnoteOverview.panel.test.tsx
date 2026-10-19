/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { FootnoteOverview, type FootnoteOverviewProps } from "./FootnoteOverview";
import type { DocFootnote } from "../util/docFootnotes";

const MARK: DocFootnote = {
  id: "mark-1",
  kind: "note",
  anchor: { kind: "text", start: 0, end: 4, scope: "p6" },
  excerpt: "Contents",
  createdAt: 1,
  notes: [{ id: "n1", text: "a note", createdAt: 1, updatedAt: 1 }],
};

let mountedRoot: ReturnType<typeof createRoot> | undefined;
function mount(footnote: DocFootnote, overrides: Partial<FootnoteOverviewProps> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mountedRoot = root;
  let props: FootnoteOverviewProps = {
    footnote, onChange: () => {}, onClose: () => {}, threadMessages: () => [],
    onSendCoach: () => {}, onOpenExternal: () => {}, subMarkMode: null,
    onSubMarkModeChange: () => {}, ...overrides,
  };
  act(() => root.render(<FootnoteOverview {...props} />));
  return {
    rerender: (patch: Partial<FootnoteOverviewProps>) => {
      props = { ...props, ...patch };
      act(() => root.render(<FootnoteOverview {...props} />));
    },
  };
}

// Give the panel real dimensions before its first layout effect runs.
function mockPanelLayout() {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("lc-footnote-overview") ? Number.parseFloat(this.style.width) || 260 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("lc-footnote-overview") ? Number.parseFloat(this.style.height) || 300 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("lc-footnote-overview")
      ? new DOMRect(Number.parseFloat(this.style.left) || 0, Number.parseFloat(this.style.top) || 0, this.offsetWidth, this.offsetHeight)
      : new DOMRect();
  });
}
function panelPlacement(panel: HTMLElement) {
  return { left: panel.style.left, top: panel.style.top, width: panel.style.width,
    height: panel.style.height, maxHeight: panel.style.maxHeight };
}
function pointer(target: HTMLElement, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => target.dispatchEvent(event));
}

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot!.unmount());
  mountedRoot = undefined;
  document.body.textContent = "";
  vi.restoreAllMocks();
});

/** Tap a note row so its buttons slide out (they are hidden until then). */
function reveal(n: number) {
  if (document.querySelector(`[aria-label="Open mini note ${n}"]`)) return;
  act(() => document.querySelector<HTMLButtonElement>(`[aria-label^="Note ${n}:"]`)!.click());
}

function confirmHold(button: HTMLButtonElement) {
  const time = vi.spyOn(performance, "now").mockReturnValue(0);
  act(() => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  time.mockReturnValue(2000);
  act(() => button.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })));
  time.mockRestore();
}

describe("FootnoteOverview panel", () => {
  it("saves a new text-only note with an explicit empty images list", async () => {
    const onChange = vi.fn();
    mount({ ...MARK, notes: [] }, { onChange });
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Add Notes"]')!.click());
    await vi.waitFor(() => expect(document.querySelector('textarea[aria-label="Note"]')).not.toBeNull());
    const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "A thought");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Save")!.click());
    expect(onChange.mock.calls.at(-1)![0].notes).toMatchObject([{ text: "A thought", images: [] }]);
  });

  it("saves [] after the last picture is removed from an existing note", async () => {
    const onChange = vi.fn();
    mount({ ...MARK, notes: [{ ...MARK.notes![0], images: ["YQ=="] }] }, { onChange });
    reveal(1);
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Edit note 1"]')!.click());
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Remove picture 1"]')).not.toBeNull());
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Remove picture 1"]')!.click());
    act(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Save")!.click());
    expect(onChange.mock.calls.at(-1)![0].notes[0].images).toEqual([]);
  });

  it("resets the panel's collections to explicit empty lists", () => {
    const onChange = vi.fn();
    mount(MARK, { onChange });
    const reset = document.querySelector<HTMLButtonElement>(".lc-footnote-panel-reset")!;
    confirmHold(reset);
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ notes: [], userLinks: [], threads: [], subMarks: [] });
  });

  it.each(["whiteboards", "threads", "subMarks"] as const)("saves [] when the last %s entry is removed", field => {
    const onChange = vi.fn();
    const entries = {
      whiteboards: [{ id: "wb", title: "Scratch", createdAt: 1, updatedAt: 1 }],
      threads: [{ rootId: "turn", title: "Conversation", createdAt: 1 }],
      subMarks: [{ id: "sm", kind: "underline" as const, excerpt: "Contents", start: 0, end: 4 }],
    };
    mount({ ...MARK, ...entries }, { onChange });
    if (field === "subMarks") act(() => document.querySelector<HTMLButtonElement>('[aria-label="Remove underline"]')!.click());
    else confirmHold(document.querySelector<HTMLButtonElement>(field === "whiteboards" ? '[aria-label^="Scratch —"]' : '[aria-label^="Conversation. Tap"]')!);
    expect(onChange.mock.calls.at(-1)![0][field]).toEqual([]);
  });

  it("saves [] when the last user link is removed", async () => {
    const onChange = vi.fn();
    mount({ ...MARK, userLinks: [{ title: "My link", url: "https://example.com" }] }, { onChange });
    act(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("My link"))!.click());
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Remove link"]')).not.toBeNull());
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Remove link"]')!.click());
    expect(onChange.mock.calls.at(-1)![0].userLinks).toEqual([]);
  });

  it("saves [] when the last note is edited to contain nothing", async () => {
    const onChange = vi.fn();
    mount(MARK, { onChange }); reveal(1);
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Edit note 1"]')!.click());
    await vi.waitFor(() => expect(document.querySelector('textarea[aria-label="Note"]')).not.toBeNull());
    const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Save")!.click());
    expect(onChange.mock.calls.at(-1)![0].notes).toEqual([]);
  });

  it("shows assistant app failures on pending footnotes", () => {
    mount({ ...MARK, pending: "fr-app" }, { pendingStatus: "Codex couldn't finish. Open Settings → ChatBot → Test." });
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Codex couldn't finish. Open Settings → ChatBot → Test.");
  });
  it("shows a note as a chip; a tap slides its buttons out and a pause slides them away", async () => {
    vi.useFakeTimers();
    try {
      mount(MARK);
      expect(document.querySelector(".lc-footnote-note-row .lc-footnote-item-chip")?.textContent).toBe("a note");
      expect(document.querySelector('[aria-label="Open mini note 1"]')).toBeNull();
      act(() => document.querySelector<HTMLButtonElement>('[aria-label^="Note 1:"]')!.click());
      expect(document.querySelector('[aria-label="Open mini note 1"]')).not.toBeNull();
      expect(document.querySelector('[aria-label="Edit note 1"]')).not.toBeNull();
      await act(async () => { vi.advanceTimersByTime(4100); });
      vi.useRealTimers();
      await vi.waitFor(() => expect(document.querySelector('[aria-label="Open mini note 1"]')).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the notes as one when asked, in the panel, a mini note and the note tab", async () => {
    localStorage.removeItem("whiteboard.footnoteNotesCombined.v1");
    const onOpenFullNote = vi.fn();
    const many = { ...MARK, notes: [
      { id: "n1", text: "**Finish times:** first", createdAt: 1, updatedAt: 1 },
      { id: "n2", text: "second", createdAt: 2, updatedAt: 2 },
    ] };
    mount(many, { onOpenFullNote });
    expect(document.querySelectorAll(".lc-footnote-note-row")).toHaveLength(2);
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Show the notes as one"]')!;
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const rows = document.querySelectorAll(".lc-footnote-note-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector(".lc-footnote-item-chip")!.textContent).toBe("All notes (2)");
    act(() => document.querySelector<HTMLButtonElement>('[aria-label^="All notes:"]')!.click());
    expect(document.querySelector('[aria-label="Edit note 1"]')).toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open full note 1"]')!.click());
    expect(onOpenFullNote).toHaveBeenCalledWith("nt-all");
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open mini note 1"]')!.click());
    await vi.waitFor(() => expect(document.querySelector(".lc-footnote-mini-note .lc-footnote-note-body")?.textContent).toContain("second"));
    expect(document.querySelector(".lc-footnote-mini-note strong")?.textContent).toContain("All notes");
    act(() => toggle.click());
    expect(document.querySelectorAll(".lc-footnote-note-row")).toHaveLength(2);
    localStorage.removeItem("whiteboard.footnoteNotesCombined.v1");
  });

  it("replaces the ✕ with a Reset button in the tools row", () => {
    mount(MARK);
    const toolbar = document.querySelector(".lc-footnote-overview-toolbar")!;
    const reset = toolbar.querySelector(".lc-footnote-panel-reset");
    expect(reset?.textContent).toContain("Reset");
    expect(document.querySelector(".lc-footnote-panel-clear")).toBeNull();
  });

  it("offers Reset only when there is something to reset, and never read-only", () => {
    mount({ ...MARK, notes: [] });
    expect(document.querySelector(".lc-footnote-panel-reset")).toBeNull();
    act(() => mountedRoot!.unmount());
    mount(MARK, { readOnly: true });
    expect(document.querySelector(".lc-footnote-panel-reset")).toBeNull();
  });

  it("has a drag grip and a keyboard-operable resize handle", () => {
    mount(MARK);
    const panel = document.querySelector<HTMLElement>(".lc-footnote-overview")!;
    expect(panel.querySelector(".lc-footnote-panel-grip")).not.toBeNull();
    const resize = panel.querySelector<HTMLButtonElement>('[aria-label="Resize footnote panel"]')!;
    expect(resize).not.toBeNull();
    // jsdom has no layout; give the panel a box so the resize has a start size.
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(40, 50, 260, 300));
    act(() => { resize.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(panel.style.width).toBe("276px");
    expect(panel.style.height).toBe("300px");
    act(() => { resize.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(panel.style.height).toBe("316px");
  });

  it("keeps its automatic position and size when controlled mini notes open or close", () => {
    mockPanelLayout();
    const view = mount(MARK, { anchorRect: new DOMRect(440, 160, 120, 24), onOpenMiniNote: () => {}, miniNoteCount: 0 });
    const panel = document.querySelector<HTMLElement>(".lc-footnote-overview")!;
    const original = panelPlacement(panel);
    expect(Number.parseFloat(original.left)).toBeGreaterThan(8);
    expect(Number.parseFloat(original.top)).toBeGreaterThan(8);
    for (const miniNoteCount of [1, 2, 3, 2, 1, 0]) {
      view.rerender({ miniNoteCount, openMiniNoteIds: miniNoteCount ? ["n1"] : [] });
      expect(panelPlacement(panel)).toEqual(original);
    }
  });

  it("keeps its dragged position and size when controlled mini notes open or close", () => {
    mockPanelLayout();
    const view = mount(MARK, { anchorRect: new DOMRect(440, 160, 120, 24), onOpenMiniNote: () => {}, miniNoteCount: 0 });
    const panel = document.querySelector<HTMLElement>(".lc-footnote-overview")!;
    const original = panelPlacement(panel);
    pointer(panel.querySelector<HTMLElement>(".lc-footnote-panel-grip")!, "pointerdown", 450, 200);
    pointer(panel, "pointermove", 530, 260); pointer(panel, "pointerup", 530, 260);
    const dragged = panelPlacement(panel);
    expect(Number.parseFloat(dragged.left)).toBe(Number.parseFloat(original.left) + 80);
    expect(Number.parseFloat(dragged.top)).toBe(Number.parseFloat(original.top) + 60);
    for (const miniNoteCount of [1, 3, 2, 0]) {
      view.rerender({ miniNoteCount }); expect(panelPlacement(panel)).toEqual(dragged);
    }
  });

  it("keeps the panel in place while its own mini notes open and close", () => {
    mockPanelLayout();
    mount({ ...MARK, notes: Array.from({ length: 3 }, (_, index) => ({
      id: `n${index + 1}`, text: `note ${index + 1}`, createdAt: 1, updatedAt: 1,
    })) }, { anchorRect: new DOMRect(440, 160, 120, 24) });
    const panel = document.querySelector<HTMLElement>(".lc-footnote-overview")!;
    const original = panelPlacement(panel);
    for (let index = 1; index <= 3; index++) {
      reveal(index);
      act(() => panel.querySelector<HTMLButtonElement>(`[aria-label="Open mini note ${index}"]`)!.click());
      expect(document.querySelectorAll(".lc-footnote-mini-note")).toHaveLength(index);
      expect(panelPlacement(panel)).toEqual(original);
    }
    for (const noteId of ["n2", "n1", "n3"]) {
      const mini = document.querySelector(`[data-note-id="${noteId}"]`)!;
      act(() => mini.querySelector<HTMLButtonElement>('[aria-label="Close mini note"]')!.click());
      expect(panelPlacement(panel)).toEqual(original);
    }
    expect(document.querySelector(".lc-footnote-mini-note")).toBeNull();
  });
  it("sections fold under their title, with a count, and remember it for the session", () => {
    const notes = Array.from({ length: 3 }, (_, index) => ({ id: `f${index}`, text: `note ${index}`, createdAt: 1, updatedAt: 1 }));
    mount({ ...MARK, notes });
    const section = () => document.querySelector<HTMLElement>('section[aria-label="Notes"]')!;
    const toggle = () => section().querySelector<HTMLButtonElement>(".lc-footnote-overview-section-toggle")!;
    const fold = () => section().querySelector<HTMLElement>(".lc-footnote-overview-section-fold")!;
    const body = () => section().querySelector<HTMLElement>(".lc-footnote-overview-section-body")!;
    // Earlier tests here may have unfolded Notes (it is remembered): start folded.
    if (toggle().getAttribute("aria-expanded") === "true") act(() => toggle().click());
    // Folded: the title and how many, and nothing under it can take a tap.
    expect(toggle().textContent).toBe("▸Notes3");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(fold().hasAttribute("data-open")).toBe(false);
    expect(body().hasAttribute("inert")).toBe(true);
    act(() => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(fold().hasAttribute("data-open")).toBe(true);
    expect(body().hasAttribute("inert")).toBe(false);
    // The next panel opens it the same way.
    act(() => mountedRoot!.unmount());
    mount({ ...MARK, notes });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    act(() => toggle().click());
    expect(fold().hasAttribute("data-open")).toBe(false);
    // An empty section has nothing to fold: just its title.
    const links = document.querySelector<HTMLElement>('section[aria-label="Links"]')!;
    expect(links.querySelector(".lc-footnote-overview-section-toggle")).toBeNull();
    expect(links.querySelector(".lc-footnote-overview-section-fold")!.hasAttribute("data-open")).toBe(true);
  });

  // Last: the dragged size is remembered for the session (a module value).
  it("a resize drag stops at the screen's edge and leaves the full placement for the release", () => {
    let observed: (() => void) | null = null;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observed = callback; } observe() {} disconnect() {} });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
    mount(MARK);
    const panel = document.querySelector<HTMLElement>(".lc-footnote-overview")!;
    const resize = panel.querySelector<HTMLButtonElement>('[aria-label="Resize footnote panel"]')!;
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(40, 50, 260, 300));
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(event, "pointerId", { value: 7 });
      act(() => { resize.dispatchEvent(event); });
    };
    const findsMark = vi.spyOn(document, "querySelectorAll");
    const placements = () => findsMark.mock.calls.filter(([selector]) => String(selector).includes("lc-doc-footnote-pack")).length;
    pointer("pointerdown", 300, 350);
    pointer("pointermove", 5000, 5000);
    // Far past the corner: the size stops 8 px inside the window, the corner where it was.
    expect(panel.style.width).toBe(`${window.innerWidth - 8 - 40}px`);
    expect(panel.style.height).toBe(`${window.innerHeight - 8 - 50}px`);
    // The page holds still while the panel resizes, as for the agent panel's sash.
    expect(document.body.dataset.lcPanelMotion).toBe("true");
    expect(panel.classList.contains("is-resizing")).toBe(true);
    // Every frame's size change reaches the observer; it does not place the panel mid-drag.
    const before = placements();
    act(() => observed!());
    expect(placements()).toBe(before);
    pointer("pointerup", 5000, 5000);
    expect(placements()).toBeGreaterThan(before);
    expect(document.body.dataset.lcPanelMotion).toBeUndefined();
    expect(panel.classList.contains("is-resizing")).toBe(false);
    // After the release the observer places it again.
    const released = placements();
    act(() => observed!());
    expect(placements()).toBeGreaterThan(released);
    vi.unstubAllGlobals();
  });
});
