/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act, useState } from "react";

import { useFootnoteHistory } from "./footnoteHistory";
import type { DocFootnote } from "../util/docFootnotes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MARK: DocFootnote = {
  id: "mark-1",
  kind: "note",
  anchor: { kind: "text", start: 0, end: 4, scope: "p6" },
  excerpt: "Contents",
  createdAt: 1,
  notes: [{ id: "n1", text: "first", createdAt: 1, updatedAt: 1 }],
};

type Api = ReturnType<typeof useFootnoteHistory> & { footnote: DocFootnote; set: (next: DocFootnote) => void };

function mount(clock: { t: number }, links: string[]) {
  const api = {} as Api;
  function Harness() {
    const [footnote, set] = useState(MARK);
    const history = useFootnoteHistory({
      footnote,
      onChange: set,
      onRemoveLink: (id) => links.push(`-${id}`),
      onRestoreLink: (id) => links.push(`+${id}`),
      now: () => clock.t,
    });
    Object.assign(api, history, { footnote, set });
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<Harness />));
  roots.push(root);
  return api;
}

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { roots.splice(0).forEach((root) => act(() => root.unmount())); });

function withNote(text: string, base: DocFootnote): DocFootnote {
  return { ...base, notes: [...(base.notes ?? []), { id: `n-${text}`, text, createdAt: 2, updatedAt: 2 }] };
}

describe("footnote panel history", () => {
  it("ignores explicit empty defaults and restores the empty whiteboard list", () => {
    const api = mount({ t: 1000 }, []);
    act(() => api.set({ ...api.footnote, threads: [], bands: [], subMarks: [], userLinks: [], artifacts: [], notes: MARK.notes!.map(note => ({ ...note, images: [] })) }));
    expect(api.canUndo).toBe(false);
    act(() => api.set(withNote("second", api.footnote)));
    act(() => api.undo());
    expect(api.footnote.whiteboards).toEqual([]);
  });
  it("undoes and redoes a change, whoever made it", () => {
    const clock = { t: 1000 };
    const api = mount(clock, []);
    expect(api.canUndo).toBe(false);
    act(() => api.set(withNote("second", api.footnote)));
    expect(api.canUndo).toBe(true);
    act(() => api.undo());
    expect(api.footnote.notes?.map((note) => note.text)).toEqual(["first"]);
    expect(api.canRedo).toBe(true);
    act(() => api.redo());
    expect(api.footnote.notes?.map((note) => note.text)).toEqual(["first", "second"]);
    expect(api.canRedo).toBe(false);
  });

  it("folds quick changes into one step, and keeps slower ones apart", () => {
    const clock = { t: 1000 };
    const api = mount(clock, []);
    act(() => api.set({ ...api.footnote, title: "D" }));
    clock.t += 200;
    act(() => api.set({ ...api.footnote, title: "DFS" }));
    clock.t += 5000;
    act(() => api.set({ ...api.footnote, title: "DFS!" }));
    act(() => api.undo());
    expect(api.footnote.title).toBe("DFS");
    act(() => api.undo());
    expect(api.footnote.title).toBeUndefined();
    expect(api.canUndo).toBe(false);
  });

  it("a new change after undo clears redo", () => {
    const clock = { t: 1000 };
    const api = mount(clock, []);
    act(() => api.set({ ...api.footnote, title: "A" }));
    act(() => api.undo());
    clock.t += 100;
    act(() => api.set({ ...api.footnote, title: "B" }));
    expect(api.canRedo).toBe(false);
    act(() => api.undo());
    expect(api.footnote.title).toBeUndefined();
  });

  it("keeps whiteboards as they are now", () => {
    const clock = { t: 1000 };
    const api = mount(clock, []);
    act(() => api.set({ ...api.footnote, title: "T" }));
    const board = { id: "wb-1", title: "Board", createdAt: 3, updatedAt: 3 };
    clock.t += 5000;
    act(() => api.set({ ...api.footnote, whiteboards: [board] } as DocFootnote));
    act(() => api.undo());
    expect(api.footnote.title).toBeUndefined();
    expect(api.footnote.whiteboards).toEqual([board]);
  });

  it("an unlinked workspace link comes back on undo and goes again on redo", () => {
    const links: string[] = [];
    const api = mount({ t: 1000 }, links);
    act(() => api.removeLink("edge-1"));
    act(() => api.undo());
    act(() => api.redo());
    expect(links).toEqual(["-edge-1", "+edge-1", "-edge-1"]);
  });
});
