/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  drawLazyBlocksIn,
  placeLazyWindow,
  releaseLazyBlocks,
  showLazyBlocksBetween,
} from "./lazyBlockWindow";

/** A slot shown at half size, holding `count` lazy paragraphs 100 units tall, one under the other. */
function note(count: number) {
  const slot = document.createElement("div");
  Object.defineProperty(slot, "offsetWidth", { value: 400 });
  Object.defineProperty(slot, "offsetHeight", { value: count * 100 });
  slot.getBoundingClientRect = () => ({ top: -500, width: 200, height: count * 50 }) as DOMRect;
  const body = document.createElement("div");
  slot.append(body);
  const blocks = Array.from({ length: count }, (_, i) => {
    const p = document.createElement("p");
    p.textContent = `block ${i}`;
    p.setAttribute("style", "content-visibility:auto;contain-intrinsic-size:100px");
    p.getBoundingClientRect = () => ({ top: -500 + i * 50, bottom: -500 + i * 50 + 50, height: 50, width: 200 }) as DOMRect;
    body.append(p);
    return p;
  });
  document.body.append(slot);
  return { slot, body, blocks, shown: () => blocks.map((b) => b.style.contentVisibility) };
}

afterEach(() => {
  document.body.textContent = "";
});

describe("lazy blocks in Pages reading", () => {
  it("shows the blocks in the window, hides the rest, and puts auto back for scroll reading", () => {
    const { slot, shown } = note(8);
    expect(showLazyBlocksBetween(slot, 250, 520)).toBe(8);
    // Measured through the camera's half scale: block i is i*100 to i*100+100 in slot units.
    expect(shown()).toEqual(["hidden", "hidden", "visible", "visible", "visible", "visible", "hidden", "hidden"]);
    // Moving the window only touches the blocks that cross its edges.
    expect(showLazyBlocksBetween(slot, 350, 620)).toBe(2);
    releaseLazyBlocks(slot);
    expect(shown().every((v) => v === "auto")).toBe(true);
  });

  it("bounds each block it draws as auto did, so a hit test skips the blocks it misses, and unbounds them for scroll reading", () => {
    const { slot, blocks } = note(4);
    const bounds = () => blocks.map((b) => `${b.style.isolation || "-"}/${b.style.overflow || "-"}`);
    showLazyBlocksBetween(slot, 0, 150);
    expect(bounds()).toEqual(["isolate/clip", "isolate/clip", "-/-", "-/-"]);
    // Hidden again, it keeps them: nothing to undo when it comes back.
    showLazyBlocksBetween(slot, 250, 350);
    expect(bounds()).toEqual(["isolate/clip", "isolate/clip", "isolate/clip", "isolate/clip"]);
    expect(blocks[0]!.style.contentVisibility).toBe("hidden");
    releaseLazyBlocks(slot);
    expect(bounds()).toEqual(["-/-", "-/-", "-/-", "-/-"]);
    expect(blocks[0]!.getAttribute("style")).toBe("content-visibility: auto; contain-intrinsic-size: 100px;");
  });

  it("leaves blocks that always lay out alone", () => {
    const { slot, body } = note(3);
    const list = document.createElement("ul");
    list.getBoundingClientRect = () => ({ top: 1000, bottom: 1100, height: 100, width: 200 }) as DOMRect;
    body.append(list);
    showLazyBlocksBetween(slot, 0, 50);
    expect(list.getAttribute("style")).toBeNull();
  });

  it("measures again when the note is rendered anew", () => {
    const { slot, body, blocks } = note(3);
    showLazyBlocksBetween(slot, 0, 50);
    expect(blocks[2]!.style.contentVisibility).toBe("hidden");
    const late = document.createElement("p");
    late.setAttribute("style", "content-visibility:auto;contain-intrinsic-size:100px");
    late.getBoundingClientRect = () => ({ top: -500, bottom: -450, height: 50, width: 200 }) as DOMRect;
    body.prepend(late);
    showLazyBlocksBetween(slot, 0, 50);
    expect(late.style.contentVisibility).toBe("visible");
  });

  it("draws the open page's spread at once, and the wider window when the hand rests", () => {
    const { slot, shown } = note(20);
    const later: (() => void)[] = [];
    const cancelled: number[] = [];
    const fake = (work: () => void) => {
      const i = later.push(work) - 1;
      return () => cancelled.push(i);
    };
    const letters = () => shown().map((v) => v[0]).join("");
    // First page shown, at 600 with pages 100 high: 2 pages back to 4 ahead,
    // 400 to 1000, now (blocks 3 to 10, those touching an edge included).
    placeLazyWindow(slot, 600, 100, fake);
    expect(letters()).toBe("aaavvvvvvvvaaaaaaaaa");
    // 4 pages back to 8 ahead, 200 to 1400, once the hand rests: blocks 1 to 14.
    expect(later).toHaveLength(1);
    later[0]!();
    expect(letters()).toBe("hvvvvvvvvvvvvvvhhhhh");
    // A turn on: its spread and the next are drawn already, so the rest waits.
    placeLazyWindow(slot, 800, 100, fake);
    expect(later).toHaveLength(2);
    expect(shown()[16]).toBe("hidden");
    // Another turn before the rest happened: the wait starts over.
    placeLazyWindow(slot, 1000, 100, fake);
    expect(cancelled).toEqual([1]);
    later[2]!();
    // 600 to 1800: blocks 5 to 18.
    expect(letters()).toBe("hhhhhvvvvvvvvvvvvvvh");
    // A run of quick turns past it: the spread after the next comes now, and
    // nothing is hidden until the hand rests.
    placeLazyWindow(slot, 1600, 100, fake);
    expect(letters()).toBe("hhhhhvvvvvvvvvvvvvvv");
  });

  it("draws a jump's page at once even with a wait pending", () => {
    const { slot, shown } = note(40);
    const later: (() => void)[] = [];
    const fake = (work: () => void) => {
      later.push(work);
      return () => {};
    };
    placeLazyWindow(slot, 600, 100, fake);
    placeLazyWindow(slot, 3000, 100, fake);
    expect(shown()[30]).toBe("visible");
    expect(shown()[6]).toBe("visible");
    later.at(-1)!();
    expect(shown()[6]).toBe("hidden");
  });

  it("draws every block of a copy, hidden or watched on the board", () => {
    const copy = document.createElement("div");
    copy.innerHTML = '<p style="content-visibility:hidden;contain-intrinsic-size:10px">a</p>' +
      '<p style="content-visibility:auto;contain-intrinsic-size:10px">b</p><p>c</p>';
    drawLazyBlocksIn(copy);
    expect(Array.from(copy.querySelectorAll("p"), (p) => p.style.contentVisibility)).toEqual(["visible", "visible", ""]);
    expect(Array.from(copy.querySelectorAll("p"), (p) => p.style.isolation + p.style.overflow)).toEqual(["isolateclip", "isolateclip", ""]);
  });

  it("does nothing for a note with no lazy blocks", () => {
    const slot = document.createElement("div");
    slot.innerHTML = "<p>short</p>";
    const later = vi.fn(() => () => {});
    placeLazyWindow(slot, 0, 100, later);
    expect(showLazyBlocksBetween(slot, 0, 100)).toBe(0);
    expect(slot.querySelector("p")!.getAttribute("style")).toBeNull();
  });
});
