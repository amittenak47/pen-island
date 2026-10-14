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

describe("FootnoteOverview panel", () => {
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
});
