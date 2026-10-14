/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { FootnoteOverview, type FootnoteOverviewProps } from "./FootnoteOverview";
import type { DocFootnote } from "../util/docFootnotes";

const MARK: DocFootnote = {
  id: "same",
  kind: "note",
  anchor: { kind: "text", start: 0, end: 4, scope: "p6" },
  excerpt: "Contents",
  createdAt: 1,
  notes: [{ id: "n1", text: "a note that is already here", createdAt: 1, updatedAt: 1 }],
  whiteboards: [{ id: "wb1", title: "scratch", createdAt: 1, updatedAt: 1 }],
};

let mountedRoot: ReturnType<typeof createRoot> | undefined;
function mount(readOnly: boolean, footnote = MARK, props: Partial<FootnoteOverviewProps> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mountedRoot = root;
  const onChange = vi.fn();
  act(() =>
    root.render(
      <FootnoteOverview
        footnote={footnote}
        readOnly={readOnly}
        onChange={onChange}
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
  return { root, onChange };
}

function addButtons() {
  return Array.from(document.querySelectorAll(".lc-footnote-overview-add"));
}

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot!.unmount());
  mountedRoot = undefined;
  document.body.textContent = "";
});

/** Tap a note row so its buttons slide out (they are hidden until then). */
function reveal(n: number) {
  if (document.querySelector(`[aria-label="Open mini note ${n}"]`)) return;
  act(() => document.querySelector<HTMLButtonElement>(`[aria-label^="Note ${n}:"]`)!.click());
}

describe("FootnoteOverview readOnly", () => {
  it("still shows what the mark holds", () => {
    /*
     * The conflict split mounts one of these per pane. Hiding the contents
     * would defeat the point — the reader is comparing two copies of the same
     * mark, and the difference is exactly what is in them.
     */
    mount(true);
    const text = document.body.textContent ?? "";
    expect(text).toContain("a note that is already here");
    expect(text).toContain("scratch");
  });

  it("offers nothing that would write to it", () => {
    // Keep is the only write in that flow; a note added to the copy that is
    // about to lose would be thrown away without saying so.
    mount(true);
    expect(addButtons()).toHaveLength(0);
    expect(document.querySelector('[aria-label="Underline"]')).toBeNull();
  });

  it("names the title without offering to rename it", () => {
    mount(true);
    const title = document.querySelector(".lc-footnote-overview-title-display");
    expect(title?.getAttribute("aria-label")).toBe("Mark title");
  });

  it("is the writable card everywhere else", () => {
    mount(false);
    expect(addButtons().length).toBeGreaterThan(0);
    expect(document.querySelector('[aria-label="Underline"]')).not.toBeNull();
  });

  it("opens a separate mini while keeping the completed ChatBot footnote visible", async () => {
    const { onChange } = mount(false, { ...MARK, kind: "ai" }, { number: 2,
      displayTheme: { color: "#0d9488", palette: ["#0d9488", "#115e59", "#5eead4", "#ccfbf1"] } });
    expect(document.querySelector('[aria-label="Add Notes"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Underline"]')).not.toBeNull();
    reveal(1);
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open mini note 1"]')!.click());
    await vi.waitFor(() => expect(document.querySelector('.lc-footnote-mini-note .lc-footnote-note-body')?.textContent).toContain(MARK.notes![0]!.text));
    const card = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Footnote 2"]')!;
    const mini = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Mini note 2.1"]')!;
    expect(card).not.toBeNull();
    expect(mini).not.toBeNull();
    for (const variable of ["--lc-fn-color", "--lc-fn-wash", "--lc-fn-ink"]) {
      expect(mini.style.getPropertyValue(variable)).toBe(card.style.getPropertyValue(variable));
    }
    act(() => mini.querySelector<HTMLButtonElement>('[aria-label="Close mini note"]')!.click());
    expect(document.querySelector('.lc-footnote-mini-note')).toBeNull();
    expect(document.querySelector('[aria-label="Footnote 2"]')).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reads a conflict copy in a mini without offering editing or a tab of a different copy", async () => {
    const { onChange } = mount(true, { ...MARK, kind: "ai" });
    reveal(1);
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open mini note 1"]')!.click());
    await vi.waitFor(() => expect(document.querySelector('.lc-footnote-mini-note .lc-footnote-note-body')?.textContent).toContain(MARK.notes![0]!.text));
    expect(document.querySelector('[aria-label="Edit note 1"]')).toBeNull();
    expect(document.querySelector('[aria-label="Open full note 1"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("sends full opening to the tab owner and leaves the footnote card in place", () => {
    const onOpenFullNote = vi.fn();
    const { onChange } = mount(false, MARK, { onOpenFullNote });
    reveal(1);
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open full note 1"]')!.click());
    expect(onOpenFullNote).toHaveBeenCalledWith("n1");
    expect(document.querySelector('[aria-label="Footnote"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Full note"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("limits separate minis to three, reuses an open note, and permits another after closing", () => {
    mount(false, { ...MARK, notes: Array.from({ length: 4 }, (_, i) => ({
      id: `n${i + 1}`, text: `note ${i + 1}`, createdAt: 1, updatedAt: 1,
    })) });
    const open = (n: number) => { reveal(n); act(() => document.querySelector<HTMLButtonElement>(`[aria-label="Open mini note ${n}"]`)!.click()); };
    open(1); open(2); open(3); open(1); open(4);
    expect(document.querySelectorAll('.lc-footnote-mini-note')).toHaveLength(3);
    reveal(4);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Open mini note 4"]')!.disabled).toBe(true);
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close mini note"]')!.click());
    open(4);
    expect(document.querySelectorAll('.lc-footnote-mini-note')).toHaveLength(3);
    expect(document.querySelector('.lc-footnote-mini-note[data-note-id="n4"]')).not.toBeNull();
  });
});
