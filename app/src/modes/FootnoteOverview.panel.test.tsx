/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
function mount(footnote: DocFootnote, props: Partial<FootnoteOverviewProps> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mountedRoot = root;
  act(() =>
    root.render(
      <FootnoteOverview
        footnote={footnote}
        onChange={() => {}}
        onClose={() => {}}
        threadMessages={() => []}
        onSendCoach={() => {}}
        onOpenExternal={() => {}}
        subMarkMode={null}
        onSubMarkModeChange={() => {}}
        {...props}
      />,
    ),
  );
}

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
});
