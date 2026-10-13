/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FootnoteMiniNotes, type MiniNoteEntry } from "./FootnoteMiniNotes";

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.textContent = ""; });
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
});
