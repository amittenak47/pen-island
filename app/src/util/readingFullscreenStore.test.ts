/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const motion = vi.hoisted(() => ({ animate: vi.fn(async (_root: HTMLElement, _entering: boolean, changeLayout: () => void) => { changeLayout?.(); }) }));
const native = vi.hoisted(() => ({ apply: vi.fn(async () => {}) }));
vi.mock("./fullscreenMotion", () => ({ animateFullscreenChange: motion.animate }));
vi.mock("./readingFullscreen", () => ({ applyReadingFullscreen: native.apply }));
import { isReadingFullscreen, registerFullscreenRoot, setReadingFullscreen, subscribeReadingFullscreen, toggleReadingFullscreen } from "./readingFullscreenStore";

let root: HTMLDivElement;
beforeEach(() => { root = document.createElement("div"); document.body.append(root); registerFullscreenRoot(root); vi.clearAllMocks(); });
afterEach(() => { setReadingFullscreen(false); registerFullscreenRoot(null); root.remove(); });

it("toggling flips the root's data attribute, runs the motion and the native bars, and tells subscribers", () => {
  const seen = vi.fn(); const stop = subscribeReadingFullscreen(seen);
  toggleReadingFullscreen();
  expect(isReadingFullscreen()).toBe(true); expect(root.dataset.fullscreen).toBe("true");
  expect(motion.animate).toHaveBeenCalledWith(root, true, expect.any(Function)); expect(native.apply).toHaveBeenLastCalledWith(true); expect(seen).toHaveBeenCalledOnce();
  toggleReadingFullscreen();
  expect(root.dataset.fullscreen).toBeUndefined(); expect(motion.animate).toHaveBeenLastCalledWith(root, false, expect.any(Function)); expect(native.apply).toHaveBeenLastCalledWith(false);
  stop();
});

it("setting the same value again does nothing", () => {
  setReadingFullscreen(false);
  expect(motion.animate).not.toHaveBeenCalled(); expect(native.apply).not.toHaveBeenCalled();
});

it("Escape leaves full screen, and the listener is gone afterwards", () => {
  setReadingFullscreen(true);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(isReadingFullscreen()).toBe(false);
  vi.clearAllMocks();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(motion.animate).not.toHaveBeenCalled();
});

it("lets motion capture the old box and establish the hold before changing layout", () => {
  motion.animate.mockImplementationOnce((element, entering, changeLayout) => {
    expect(element).toBe(root); expect(entering).toBe(true);
    expect(root.dataset.fullscreen).toBeUndefined();
    changeLayout();
    expect(root.dataset.fullscreen).toBe("true");
    return Promise.resolve();
  });
  setReadingFullscreen(true);
  motion.animate.mockImplementationOnce((_element, entering, changeLayout) => {
    expect(entering).toBe(false); expect(root.dataset.fullscreen).toBe("true");
    changeLayout();
    expect(root.dataset.fullscreen).toBeUndefined();
    return Promise.resolve();
  });
  setReadingFullscreen(false);
});
