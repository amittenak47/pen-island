/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRAG_SCROLL_THRESHOLD, attachDragScroll, glideStep, releaseVelocity } from "./dragScroll";

function pointer(type: string, x: number, t: number, pointerType = "mouse") {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: pointerType }, timeStamp: { value: t } });
  return event;
}

function strip() {
  const el = document.createElement("nav");
  let scroll = 500;
  Object.defineProperty(el, "scrollLeft", { get: () => scroll, set: (value: number) => { scroll = Math.max(0, Math.min(5000, value)); } });
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  const thumb = document.createElement("button");
  const onThumb = vi.fn();
  thumb.addEventListener("click", onThumb);
  el.append(thumb);
  document.body.append(el);
  return { el, thumb, onThumb };
}

afterEach(() => { document.body.textContent = ""; vi.useRealTimers(); });

describe("glide", () => {
  it("slows each step and stops", () => {
    let velocity = 2;
    let travelled = 0;
    for (let i = 0; i < 200 && velocity !== 0; i++) {
      const step = glideStep(velocity, 16);
      expect(Math.abs(step.velocity)).toBeLessThan(Math.abs(velocity));
      travelled += step.dx;
      velocity = step.velocity;
    }
    expect(velocity).toBe(0);
    expect(travelled).toBeGreaterThan(100);
  });

  it("takes the release speed from the last stretch of the drag", () => {
    // Only the last 80 ms count: 80 px in 40 ms.
    expect(releaseVelocity([{ x: 0, t: 0 }, { x: 0, t: 500 }, { x: 80, t: 540 }])).toBe(2);
    expect(releaseVelocity([{ x: 10, t: 0 }])).toBe(0);
  });
});

describe("attachDragScroll", () => {
  it("drags with a mouse and swallows the click it ends on", () => {
    const { el, thumb, onThumb } = strip();
    attachDragScroll(el, () => true);
    thumb.dispatchEvent(pointer("pointerdown", 300, 0));
    thumb.dispatchEvent(pointer("pointermove", 300 - DRAG_SCROLL_THRESHOLD - 1, 10));
    thumb.dispatchEvent(pointer("pointermove", 200, 20));
    expect(el.scrollLeft).toBe(600);
    thumb.dispatchEvent(pointer("pointerup", 200, 30));
    thumb.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onThumb).not.toHaveBeenCalled();
  });

  it("keeps a still press a click on the thumbnail", () => {
    const { el, thumb, onThumb } = strip();
    attachDragScroll(el, () => true);
    thumb.dispatchEvent(pointer("pointerdown", 300, 0));
    thumb.dispatchEvent(pointer("pointermove", 302, 10));
    thumb.dispatchEvent(pointer("pointerup", 302, 20));
    thumb.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onThumb).toHaveBeenCalledOnce();
    expect(el.scrollLeft).toBe(500);
  });

  it("leaves fingers to native scrolling", () => {
    const { el, thumb } = strip();
    attachDragScroll(el, () => true);
    thumb.dispatchEvent(pointer("pointerdown", 300, 0, "touch"));
    thumb.dispatchEvent(pointer("pointermove", 100, 10, "touch"));
    expect(el.scrollLeft).toBe(500);
  });

  it("glides after a flick, and a new press stops it", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const { el, thumb } = strip();
    attachDragScroll(el, () => false);
    thumb.dispatchEvent(pointer("pointerdown", 400, 0, "pen"));
    thumb.dispatchEvent(pointer("pointermove", 380, 10, "pen"));
    thumb.dispatchEvent(pointer("pointermove", 300, 30, "pen"));
    thumb.dispatchEvent(pointer("pointerup", 300, 32, "pen"));
    const released = el.scrollLeft;
    vi.advanceTimersByTime(100);
    expect(el.scrollLeft).toBeGreaterThan(released);
    thumb.dispatchEvent(pointer("pointerdown", 300, 200, "pen"));
    const stopped = el.scrollLeft;
    vi.advanceTimersByTime(200);
    expect(el.scrollLeft).toBe(stopped);
  });
});
