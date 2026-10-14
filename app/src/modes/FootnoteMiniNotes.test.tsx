/** @vitest-environment jsdom */
import { act, StrictMode, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FootnoteMiniNotes, type MiniNoteEntry } from "./FootnoteMiniNotes";

let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.textContent = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const entry: MiniNoteEntry = {
  footnoteId: "f1", noteId: "n1", noteNumber: 1, number: 1,
  footnote: { id: "f1", kind: "note", excerpt: "Scratch", anchor: { kind: "text", start: 0, end: 7 }, createdAt: 1 },
  note: { id: "n1", text: "A movable scratch note", createdAt: 1, updatedAt: 1 },
  theme: { color: "#0d9488", palette: ["#0d9488", "#115e59", "#5eead4", "#ccfbf1"] },
};
function mount() {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const onClose = vi.fn();
  act(() => root!.render(<FootnoteMiniNotes entries={[entry]} getBounds={() => new DOMRect(100, 50, 700, 600)}
    onClose={onClose} onOpenExternal={() => {}} />));
  return { onClose, window: document.querySelector<HTMLElement>('.lc-footnote-mini-note')! };
}
function pointer(target: HTMLElement, kind: string, x: number, y: number) {
  target.setPointerCapture = vi.fn(); target.hasPointerCapture = () => true; target.releasePointerCapture = vi.fn();
  const event = new MouseEvent(kind, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => target.dispatchEvent(event));
}

const paneBounds = () => new DOMRect(100, 50, 700, 600);
const entries = [entry, { ...entry, noteId: "n2", noteNumber: 2 }, { ...entry, noteId: "n3", noteNumber: 3 }];
type MiniProps = ComponentProps<typeof FootnoteMiniNotes>;
function windows(props: Partial<MiniProps> = {}, strict = false) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const render = (visible: readonly MiniNoteEntry[], next: Partial<MiniProps> = {}) => {
    const component = <FootnoteMiniNotes getBounds={paneBounds} onClose={() => {}} onOpenExternal={() => {}} {...props} {...next} entries={visible} />;
    act(() => root!.render(strict ? <StrictMode>{component}</StrictMode> : component));
  };
  return { render };
}
function rect(noteId: string) {
  const node = document.querySelector<HTMLElement>(`.lc-footnote-mini-note[data-note-id="${noteId}"]`)!;
  return { left: parseFloat(node.style.left), top: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height) };
}

describe("mini note interactions", () => {
  it("moves by its header without closing the note or modifying its content", () => {
    const { window, onClose } = mount();
    const startLeft = parseFloat(window.style.left), startTop = parseFloat(window.style.top);
    const header = window.querySelector<HTMLElement>('.lc-footnote-note-drag')!;
    pointer(header, "pointerdown", 120, 450);
    pointer(header, "pointermove", 200, 300);
    pointer(header, "pointerup", 200, 300);
    expect(parseFloat(window.style.left)).toBe(startLeft + 80);
    expect(parseFloat(window.style.top)).toBe(startTop - 150);
    expect(window.textContent).toContain(entry.note.text);
    expect(onClose).not.toHaveBeenCalled();
  });
  it("resizes through its corner and supports keyboard size adjustment", () => {
    const { window } = mount();
    const handle = window.querySelector<HTMLElement>('[aria-label="Resize mini note"]')!;
    pointer(handle, "pointerdown", 380, 630);
    pointer(handle, "pointermove", 460, 590);
    pointer(handle, "pointerup", 460, 590);
    expect(window.style.width).toBe("360px");
    expect(window.style.height).toBe("180px");
    act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(window.style.width).toBe("376px");
  });
  it("keeps default windows fixed when other notes open or the middle one closes", () => {
    const changed = vi.fn();
    const { render } = windows({ onPlacementChange: changed });
    render(entries.slice(0, 1));
    const first = rect("n1");
    render(entries.slice(0, 2));
    expect(rect("n1")).toEqual(first);
    render(entries);
    expect(rect("n1")).toEqual(first);
    const third = rect("n3");
    render([entries[0]!, entries[2]!]);
    expect(rect("n1")).toEqual(first);
    expect(rect("n3")).toEqual(third);
    expect(changed.mock.calls.map(([key]) => key)).toEqual(["f1:n1", "f1:n2", "f1:n3"]);
    render(entries);
    expect(changed).toHaveBeenCalledTimes(3);
  });
  it("stores actual pane positions once in StrictMode even while controlled props lag", () => {
    const changed = vi.fn();
    const { render } = windows({ placements: {}, onPlacementChange: changed }, true);
    render(entries);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(changed.mock.calls[0]).toEqual(["f1:n1", { left: 108, top: 422, width: 280, height: 220 }]);
    const first = rect("n1");
    render([entries[0]!, entries[2]!]);
    expect(rect("n1")).toEqual(first);
    expect(changed).toHaveBeenCalledTimes(3);
  });
  it("shows callback-only drag commits in an uncontrolled window", () => {
    const changed = vi.fn();
    const { render } = windows({ onPlacementChange: changed }); render([entry]);
    const original = rect("n1");
    const header = document.querySelector<HTMLElement>(".lc-footnote-note-drag")!;
    pointer(header, "pointerdown", 120, 450);
    pointer(header, "pointermove", 200, 300);
    pointer(header, "pointerup", 200, 300);
    expect(rect("n1")).toEqual({ ...original, left: original.left + 80, top: original.top - 150 });
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it("shows controlled drag commits while props lag and honors later external placement updates", () => {
    const original = { left: 108, top: 422, width: 280, height: 220 };
    const changed = vi.fn();
    const { render } = windows({ placements: { "f1:n1": original }, onPlacementChange: changed });
    render([entry]);
    const header = document.querySelector<HTMLElement>(".lc-footnote-note-drag")!;
    pointer(header, "pointerdown", 120, 450);
    pointer(header, "pointermove", 200, 300);
    pointer(header, "pointerup", 200, 300);
    const moved = { ...original, left: 188, top: 272 };
    expect(rect("n1")).toEqual(moved);
    render([entry]);
    expect(rect("n1")).toEqual(moved);
    render([entry], { placements: { "f1:n1": moved } });
    render([entry], { placements: { "f1:n1": original } });
    expect(rect("n1")).toEqual(original);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("places a new note around a visible panel and ignores hidden or other-pane panels", () => {
    const panel = document.createElement("div"); panel.className = "lc-footnote-overview";
    panel.style.left = "108px"; panel.style.top = "422px"; document.body.append(panel);
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(108, 422, 280, 220));
    const hidden = document.createElement("div"); hidden.className = "lc-footnote-overview"; hidden.style.visibility = "hidden"; document.body.append(hidden);
    vi.spyOn(hidden, "getBoundingClientRect").mockReturnValue(new DOMRect(396, 422, 280, 220));
    const other = document.createElement("div"); other.className = "lc-footnote-overview"; document.body.append(other);
    vi.spyOn(other, "getBoundingClientRect").mockReturnValue(new DOMRect(900, 400, 280, 220));
    const zero = document.createElement("div"); zero.className = "lc-footnote-overview"; document.body.append(zero);
    const { render } = windows(); render([entry]);
    expect(rect("n1")).toEqual({ left: 396, top: 422, width: 280, height: 220 });
    expect(panel.style.left).toBe("108px"); expect(panel.style.top).toBe("422px");
  });
  it("clamps an existing controlled window only when its bounds change", () => {
    const original = { left: 500, top: 380, width: 350, height: 350 };
    const changed = vi.fn();
    const { render } = windows({ placements: { "f1:n1": original }, onPlacementChange: changed,
      getBounds: () => new DOMRect(100, 50, 900, 700) });
    render([entry]); expect(rect("n1")).toEqual(original); expect(changed).not.toHaveBeenCalled();
    render([entry], { getBounds: () => new DOMRect(100, 50, 400, 400) });
    expect(rect("n1")).toEqual({ left: 142, top: 92, width: 350, height: 350 });
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
