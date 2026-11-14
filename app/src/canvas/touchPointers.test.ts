/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

/** jsdom has no PointerEvent. */
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}
vi.stubGlobal("PointerEvent", TestPointerEvent);

const { syncTouchPointers } = await import("./touchPointers");

const finger = (target: Element, type: string, id: number, x = 10, y = 10) =>
  target.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", clientX: x, clientY: y, bubbles: true, cancelable: true }));

afterEach(() => {
  document.body.textContent = "";
});

describe("a handler's own list of the fingers down", () => {
  it("drops a finger whose lift a window listener kept to itself", () => {
    const root = document.createElement("div");
    const page = document.createElement("p");
    root.append(page);
    document.body.append(root);
    // A page turn lining a flick up: it keeps the lift from the board.
    const keep = (event: Event) => event.stopImmediatePropagation();
    window.addEventListener("pointerup", keep, true);
    const own = new Map<number, { x: number; y: number }>();
    root.addEventListener("pointerdown", (event) => own.set((event as PointerEvent).pointerId, { x: 0, y: 0 }), true);
    root.addEventListener("pointerup", (event) => own.delete((event as PointerEvent).pointerId), true);
    finger(page, "pointerdown", 1);
    finger(page, "pointerup", 1);
    window.removeEventListener("pointerup", keep, true);
    // The board never saw it lift: one finger too many for the next touch.
    expect([...own.keys()]).toEqual([1]);
    finger(page, "pointerdown", 2, 40, 50);
    syncTouchPointers(own, root);
    expect([...own.keys()]).toEqual([2]);
    expect(own.get(2)).toEqual({ x: 40, y: 50 });
    finger(page, "pointerup", 2);
  });

  it("keeps fingers still down, including one a page turn cancelled for itself", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const own = new Map<number, { x: number; y: number }>();
    finger(root, "pointerdown", 3);
    // The turn's own cancel: the finger is still on the glass, ready to pinch.
    finger(root, "pointercancel", 3);
    finger(root, "pointerdown", 4, 90, 90);
    syncTouchPointers(own, root);
    expect([...own.keys()].sort()).toEqual([3, 4]);
    finger(root, "pointerup", 3);
    finger(root, "pointerup", 4);
  });
});
