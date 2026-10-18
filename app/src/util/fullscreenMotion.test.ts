/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { animateFullscreenChange } from "./fullscreenMotion";
import { SPLIT_RESIZE_EVENT } from "./splitResize";

let app: HTMLDivElement, header: HTMLElement, main: HTMLElement, side: HTMLElement;
const animations: Array<{ el: Element; frames: Keyframe[]; options: KeyframeAnimationOptions; finish: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
let settles = 0;
const onSettle = (event: Event) => { if ((event as CustomEvent).detail?.phase === "settle") settles++; };
beforeEach(() => {
  vi.useFakeTimers(); animations.length = 0; settles = 0;
  window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
  Element.prototype.animate = function (this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
    let resolve!: () => void; const finished = new Promise<void>(r => { resolve = r; });
    const record = { el: this, frames, options, finish: () => resolve(), cancel: vi.fn(() => resolve()), finished };
    animations.push(record); return record as unknown as Animation;
  } as typeof Element.prototype.animate;
  app = document.createElement("div"); header = document.createElement("header"); header.className = "lc-header";
  main = document.createElement("main"); side = document.createElement("aside");
  app.append(header, main, side); document.body.append(app);
  Object.defineProperty(header, "offsetHeight", { configurable: true, value: 44 });
  window.addEventListener(SPLIT_RESIZE_EVENT, onSettle);
});
afterEach(() => { window.removeEventListener(SPLIT_RESIZE_EVENT, onSettle); app.remove(); delete document.body.dataset.lcPanelMotion; vi.useRealTimers(); });

it("entering: one refit up front, then the header box shrinks in place while the reading box enlarges", async () => {
  Object.defineProperty(app, "clientHeight", { configurable: true, value: 1000 });
  const done = animateFullscreenChange(app, true);
  expect(settles).toBe(1); // boards fit the final size before anything moves
  expect(document.body.dataset.lcPanelMotion).toBe("true"); // and do not refit mid-motion
  const head = animations.find(a => a.el === header)!;
  // A box: its bottom edge closes upward; nothing slides.
  expect(head.frames[0]).toMatchObject({ clipPath: "inset(0px 0px 0px 0px)" });
  expect(head.frames.at(-1)).toMatchObject({ clipPath: "inset(0px 0px 100% 0px)" });
  expect(head.frames.every(f => !("transform" in f))).toBe(true);
  for (const el of [main, side]) {
    const a = animations.find(x => x.el === el)!;
    // From the old box (44 px shorter, centred lower) to the full screen, uniformly.
    expect(a.frames[0]).toMatchObject({ transform: `translateY(22px) scale(${956 / 1000})` });
    expect(a.frames.at(-1)).toMatchObject({ transform: "translateY(0px) scale(1)" });
  }
  expect(new Set(animations.map(a => `${a.options.duration}|${a.options.easing}`)).size).toBe(1);
  animations.forEach(a => a.finish()); await vi.runAllTimersAsync(); await done;
  expect(document.body.dataset.lcPanelMotion).toBeUndefined();
  expect(settles).toBe(2); // one settle after the motion, measured without transforms
});

it("leaving: the header box grows back down and the reading box shrinks into place", () => {
  Object.defineProperty(app, "clientHeight", { configurable: true, value: 1000 });
  animateFullscreenChange(app, false);
  const head = animations.find(a => a.el === header)!;
  expect(head.frames[0]).toMatchObject({ clipPath: "inset(0px 0px 100% 0px)" });
  expect(head.frames.at(-1)).toMatchObject({ clipPath: "inset(0px 0px 0px 0px)" });
  expect(animations.find(a => a.el === main)!.frames[0]).toMatchObject({ transform: `translateY(-22px) scale(${1000 / 956})` });
});

it("reduced motion: no animation, one refit", async () => {
  window.matchMedia = vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia;
  await animateFullscreenChange(app, true);
  expect(animations).toHaveLength(0); expect(settles).toBe(1); expect(document.body.dataset.lcPanelMotion).toBeUndefined();
});

it("a second toggle mid-motion cancels the first and only the last geometry is fitted", async () => {
  animateFullscreenChange(app, true);
  const first = [...animations];
  const done = animateFullscreenChange(app, false);
  expect(first.every(a => a.cancel.mock.calls.length === 1)).toBe(true);
  animations.slice(first.length).forEach(a => a.finish()); await vi.runAllTimersAsync(); await done;
  expect(document.body.dataset.lcPanelMotion).toBeUndefined();
});
