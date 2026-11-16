/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  drawLazyBlocksIn,
  followScrollWindow,
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

  it("draws the open page's spread at once, the wider window when the hand rests and the far one at the next rest", () => {
    const { slot, shown } = note(40);
    const later: (() => void)[] = [];
    const cancelled: number[] = [];
    const fake = (work: () => void) => {
      const i = later.push(work) - 1;
      return () => cancelled.push(i);
    };
    const letters = () => shown().map((v) => v[0]).join("");
    const runs = (...parts: [string, number][]) => parts.map(([c, n]) => c.repeat(n)).join("");
    // First page shown, at 1600 with pages 100 high: 2 pages back to 4 ahead,
    // 1400 to 2000, now (blocks 13 to 20, those touching an edge included).
    placeLazyWindow(slot, 1600, 100, fake);
    expect(letters()).toBe(runs(["a", 13], ["v", 8], ["a", 19]));
    // Rested: 4 back to 8 ahead drawn (blocks 11 to 24), and what lies past
    // 8 back and 16 ahead hidden (all but blocks 7 to 32).
    expect(later).toHaveLength(1);
    later[0]!();
    expect(letters()).toBe(runs(["h", 7], ["a", 4], ["v", 14], ["a", 8], ["h", 7]));
    // Rested again: out to 8 back and 16 ahead.
    expect(later).toHaveLength(2);
    later[1]!();
    expect(letters()).toBe(runs(["h", 7], ["v", 26], ["h", 7]));
    // A run of quick turns on from the rest: six land with nothing to draw,
    // each starting the wait over.
    const drawn = letters();
    for (let turn = 1; turn <= 6; turn += 1) {
      placeLazyWindow(slot, 1600 + turn * 200, 100, fake);
      expect(letters()).toBe(drawn);
    }
    expect(cancelled).toEqual([2, 3, 4, 5, 6]);
    // The seventh draws the spread after the next (2800 to 3400: blocks 33
    // and 34), and still hides nothing until the hand rests.
    placeLazyWindow(slot, 3000, 100, fake);
    expect(letters()).toBe(runs(["h", 7], ["v", 28], ["h", 5]));
  });

  it("draws nothing as a run of three quick turns back from a rest lands", () => {
    const { slot, shown } = note(40);
    const later: (() => void)[] = [];
    const fake = (work: () => void) => {
      later.push(work);
      return () => {};
    };
    placeLazyWindow(slot, 2400, 100, fake);
    later.shift()!();
    later.shift()!();
    const drawn = shown().join();
    for (let turn = 1; turn <= 3; turn += 1) {
      placeLazyWindow(slot, 2400 - turn * 200, 100, fake);
      expect(shown().join()).toBe(drawn);
    }
  });

  it("draws the wider window only once the hand has rested, not between two quick flicks", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    try {
      const { slot, shown } = note(20);
      const press = (type: string) => {
        const event = new Event(type);
        Object.defineProperty(event, "pointerId", { value: 7 });
        window.dispatchEvent(event);
      };
      const letters = () => shown().map((v) => v[0]).join("");
      placeLazyWindow(slot, 600, 100);
      expect(letters()).toBe("aaavvvvvvvvaaaaaaaaa");
      // The next flick goes down while the main thread is free: a finger on the glass is no rest.
      vi.advanceTimersByTime(300);
      press("pointerdown");
      vi.advanceTimersByTime(1500);
      expect(letters()).toBe("aaavvvvvvvvaaaaaaaaa");
      // Lifted, the rest starts from the lift.
      press("pointerup");
      vi.advanceTimersByTime(700);
      expect(letters()).toBe("aaavvvvvvvvaaaaaaaaa");
      vi.advanceTimersByTime(200);
      expect(letters()).toBe("avvvvvvvvvvvvvvaaaaa");
      // And the far window a rest later.
      vi.advanceTimersByTime(900);
      expect(letters()).toBe("vvvvvvvvvvvvvvvvvvvv");
    } finally {
      vi.useRealTimers();
    }
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

describe("lazy blocks in scroll reading", () => {
  /** Each block's state as a letter: v drawn, h hidden, a left to the browser's own skipping. */
  const letters = (shown: () => string[]) => shown().map((v) => v[0]).join("");

  it("draws the view and a screen either side at once, and hides the rest: no block is left to the browser's own skipping", () => {
    const { slot, shown } = note(30);
    // The view is 1000 to 1300 (blocks 10 to 12), a screen of 300.
    followScrollWindow(slot, 1000, 1300);
    expect(letters(shown)).toBe("hhhhhhvvvvvvvvvvvhhhhhhhhhhhhh");
    releaseLazyBlocks(slot);
    expect(shown().every((v) => v === "auto")).toBe(true);
  });

  it("draws three screens further ahead in one go, only when the view comes within a screen of what is drawn", () => {
    const { slot, shown } = note(40);
    followScrollWindow(slot, 1000, 1300);
    const states: string[] = [letters(shown)];
    // Down 100 units a frame.
    for (let top = 1100; top <= 1800; top += 100) {
      followScrollWindow(slot, top, top + 300);
      states.push(letters(shown));
    }
    const changedAt = states.slice(1).map((s, i) => (s !== states[i] ? 1100 + i * 100 : 0)).filter(Boolean);
    expect(changedAt).toEqual([1100, 1800]);
    // The first: the view's screen ahead ran past what was drawn, so three screens beyond the view are drawn at once.
    expect(states[1]).toBe("hhhhhhvvvvvvvvvvvvvvvvvvhhhhhhhhhhhhhhhh");
    // Going back up, ahead is up.
    for (let top = 1700; top >= 300; top -= 100) followScrollWindow(slot, top, top + 300);
    expect(shown().slice(0, 3)).toEqual(["visible", "visible", "visible"]);
  });

  it("widens once the view has rested: far blocks hidden, three screens behind and five ahead drawn, then six and ten a rest later; not while it moves", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    try {
      const { slot, shown } = note(60);
      // Well past the last touch an earlier test made (the clock starts again with fake timers).
      vi.advanceTimersByTime(10_000);
      // A fling: the view moves down every frame for a second and a half.
      let top = 1000;
      for (let t = 0; t < 1500; t += 16) {
        followScrollWindow(slot, top, top + 300);
        top += 10;
        vi.advanceTimersByTime(16);
      }
      top -= 10;
      /** Blocks `from` to `to` drawn, the rest of `count` hidden. */
      const run = (from: number, to: number, count = 60) => "h".repeat(from) + "v".repeat(to - from + 1) + "h".repeat(count - to - 1);
      // While it moved: the near window, and three screens ahead twice, nothing hidden, nothing wider.
      const moving = letters(shown);
      expect(moving).toBe(run(6, 28));
      vi.advanceTimersByTime(700);
      expect(letters(shown)).toBe(moving);
      vi.advanceTimersByTime(200);
      // Rested at 1930 to 2230: 1030 to 3730 drawn; what it drew on the way stays, being near.
      expect(letters(shown)).toBe(run(6, 37));
      vi.advanceTimersByTime(900);
      // A rest later, 130 to 5230.
      expect(letters(shown)).toBe(run(1, 52));
      // Moved far up, a rest hides what is now far below: past six screens under the view (2500), up being ahead.
      followScrollWindow(slot, 400, 700);
      vi.advanceTimersByTime(900);
      expect(letters(shown)).toBe(run(0, 25));
    } finally {
      vi.useRealTimers();
    }
  });
});
