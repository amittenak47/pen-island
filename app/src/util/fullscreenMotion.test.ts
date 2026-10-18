/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
// @ts-expect-error Node runtime module used by Vitest; app intentionally has no Node typings.
import { readFileSync } from "node:fs";
// @ts-expect-error Node runtime module used by Vitest; app intentionally has no Node typings.
import { URL as FileURL } from "node:url";
import { animateFullscreenChange } from "./fullscreenMotion";
import { boardResizeDeferred, SPLIT_RESIZE_EVENT } from "./splitResize";

const OPEN = "inset(0px 0px 0px 0px)";
const CLOSED = "inset(0px 0px 100% 0px)";
const TRANSITION = "240ms cubic-bezier(0.22, 1, 0.36, 1)";
const css = readFileSync(new FileURL("../styles.css", import.meta.url), "utf8");
let app: HTMLDivElement, header: HTMLElement, main: HTMLElement, headerSlot: HTMLElement, agentSlot: HTMLElement;
let style: HTMLStyleElement;
const originalAnimate = Element.prototype.animate;
let settles: boolean[];
let committed: Array<{ clip: string; transform: string; transition: string; held: boolean }>;
const onSettle = (event: Event) => {
  if ((event as CustomEvent).detail?.phase === "settle") settles.push(boardResizeDeferred());
};
const rect = (top: number, height: number) => ({ top, height, left: 0, width: 800, right: 800, bottom: top + height, x: 0, y: top, toJSON() {} });
const toggle = (entering: boolean, changeLayout = () => {
  if (entering) app.dataset.fullscreen = "true";
  else delete app.dataset.fullscreen;
}) => animateFullscreenChange(app, entering, changeLayout);
const transitionEnd = (el: HTMLElement, propertyName: string) => {
  const event = new Event("transitionend", { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  el.dispatchEvent(event);
};

beforeEach(() => {
  vi.useFakeTimers(); settles = []; committed = [];
  window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
  // There is deliberately no working Web Animations API: the tablet's known
  // working sheet uses CSS transitions, and full screen must use that path too.
  vi.stubGlobal("Animation", undefined);
  Element.prototype.animate = vi.fn(() => { throw new Error("Use CSS transitions"); });
  style = document.createElement("style");
  style.textContent = css.slice(css.indexOf("/* ------------------------------------------------- reading full screen --- */"));
  document.head.append(style);
  app = document.createElement("div"); app.className = "lc-app";
  header = document.createElement("header"); header.className = "lc-header";
  main = document.createElement("main"); main.className = "lc-main";
  headerSlot = document.createElement("span"); headerSlot.className = "lc-header-slot"; headerSlot.style.display = "contents";
  agentSlot = document.createElement("span"); agentSlot.className = "lc-agent-slot"; agentSlot.style.display = "contents";
  app.append(header, headerSlot, main, agentSlot); document.body.append(app);
  Object.defineProperty(app, "clientHeight", { configurable: true, value: 1000 });
  Object.defineProperty(header, "offsetHeight", { configurable: true, value: 44 });
  vi.spyOn(main, "getBoundingClientRect").mockImplementation(() => app.hasAttribute("data-fullscreen") ? rect(0, 1000) : rect(44, 956));
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    const value = computed(el, pseudo);
    if (el === main && main.style.transform) committed.push({
      clip: header.style.clipPath, transform: main.style.transform,
      transition: value.transition, held: boardResizeDeferred(),
    });
    return value;
  });
  window.addEventListener(SPLIT_RESIZE_EVENT, onSettle);
});
afterEach(async () => {
  await vi.runAllTimersAsync();
  window.removeEventListener(SPLIT_RESIZE_EVENT, onSettle);
  app.remove(); style.remove(); delete document.body.dataset.lcPanelMotion;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); Element.prototype.animate = originalAnimate; vi.useRealTimers();
});

it.each([true, false])("uses the sheet's CSS clip/transform clock, entering=%s, without a final-state flash", async entering => {
  if (!entering) app.dataset.fullscreen = "true";
  let layouts = 0;
  const done = toggle(entering, () => {
    // The hold and visible starting clip precede the only layout change.
    expect(boardResizeDeferred()).toBe(true);
    expect(header.style.clipPath).toBe(entering ? OPEN : CLOSED);
    layouts++;
    if (entering) app.dataset.fullscreen = "true";
    else delete app.dataset.fullscreen;
  });
  expect(layouts).toBe(1);
  expect(committed).toContainEqual({
    clip: entering ? OPEN : CLOSED,
    transform: entering ? `translateY(44px) scaleY(${956 / 1000})` : `translateY(-44px) scaleY(${1000 / 956})`,
    transition: "none", held: true,
  });
  expect(header.style.clipPath).toBe(entering ? CLOSED : OPEN);
  expect(header.style.transform).toBe(""); expect(header.style.opacity).toBe("");
  expect(getComputedStyle(header).visibility).toBe("visible");
  expect(getComputedStyle(header).transition).toBe(`clip-path ${TRANSITION}`);
  expect(main.style.transform).toBe("translateY(0px) scaleY(1)");
  expect(getComputedStyle(main).transition).toBe(`transform ${TRANSITION}`);
  expect([headerSlot, agentSlot].every(el => el.style.transform === "")).toBe(true);
  expect(settles).toEqual([]);
  expect(boardResizeDeferred()).toBe(true);
  const resize = vi.fn(() => {
    expect(main.style.transform).toBe("");
    expect(boardResizeDeferred()).toBe(false);
  });
  window.addEventListener("resize", resize);
  // Ignore descendants' transitions and unrelated properties.
  const child = document.createElement("div"); main.append(child);
  transitionEnd(child, "transform"); transitionEnd(header, "opacity");
  expect(boardResizeDeferred()).toBe(true);
  transitionEnd(header, "clip-path");
  expect(boardResizeDeferred()).toBe(true);
  transitionEnd(main, "transform");
  await done;
  expect(app.hasAttribute("data-fullscreen-motion")).toBe(false);
  expect(header.style.clipPath).toBe(""); expect(main.style.transform).toBe("");
  if (entering) expect(getComputedStyle(header).visibility).toBe("hidden");
  else expect(getComputedStyle(header).visibility).not.toBe("hidden");
  expect(settles).toEqual([false]); expect(resize).toHaveBeenCalledOnce();
  await vi.runAllTimersAsync(); expect(settles).toHaveLength(1);
  window.removeEventListener("resize", resize);
});

it("falls back to one final settle when WebView transitionend is missing", async () => {
  const done = toggle(true);
  await vi.advanceTimersByTimeAsync(239);
  expect(boardResizeDeferred()).toBe(true); expect(settles).toEqual([]);
  await vi.runAllTimersAsync(); await done;
  expect(boardResizeDeferred()).toBe(false); expect(settles).toEqual([false]);
});

it("reverses from the visible box and clip, resolves the interrupted motion and keeps the refit hold", async () => {
  const first = toggle(true);
  await vi.advanceTimersByTimeAsync(80);
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    const value = computed(el, pseudo);
    if (el === header) return { ...value, clipPath: "inset(0px 0px 60% 0px)" } as CSSStyleDeclaration;
    return value;
  });
  // Browser-measured intermediate geometry, not the first motion's target.
  vi.mocked(main.getBoundingClientRect).mockReturnValueOnce(rect(18, 982));
  const done = toggle(false);
  await expect(first).resolves.toBeUndefined();
  expect(committed).toContainEqual({
    clip: "inset(0px 0px 60% 0px)", transform: `translateY(-26px) scaleY(${982 / 956})`,
    transition: "none", held: true,
  });
  await vi.advanceTimersByTimeAsync(180); // The cancelled fallback must not settle.
  expect(boardResizeDeferred()).toBe(true); expect(settles).toEqual([]);
  transitionEnd(header, "clip-path"); transitionEnd(main, "transform");
  await done; await vi.runAllTimersAsync();
  expect(settles).toEqual([false]); expect(boardResizeDeferred()).toBe(false);
  expect(app.dataset.fullscreen).toBeUndefined();
});

it("reduced motion switches instantly, with one settle and resize and no retained motion styles", async () => {
  window.matchMedia = vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia;
  const resize = vi.fn(); window.addEventListener("resize", resize);
  await toggle(true);
  expect(app.dataset.fullscreen).toBe("true");
  expect(app.hasAttribute("data-fullscreen-motion")).toBe(false);
  expect(header.style.clipPath).toBe(""); expect(main.style.transform).toBe("");
  expect(boardResizeDeferred()).toBe(false); expect(settles).toEqual([false]);
  expect(resize).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  window.removeEventListener("resize", resize);
});

it("a reduced-motion toggle during a transition clears the old hold and settles only the new geometry", async () => {
  const first = toggle(true);
  window.matchMedia = vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia;
  await toggle(false); await first; await vi.runAllTimersAsync();
  expect(app.dataset.fullscreen).toBeUndefined();
  expect(app.hasAttribute("data-fullscreen-motion")).toBe(false);
  expect(boardResizeDeferred()).toBe(false); expect(settles).toEqual([false]);
});
