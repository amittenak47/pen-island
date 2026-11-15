/**
 * Pages reading: a note's lazy blocks near the open page drawn, the rest hidden outright.
 *
 * Off-screen paragraphs and headings carry `content-visibility: auto` (see
 * `applySkippableHeights`), and Blink keeps an intersection observer on every
 * one: on a chapter of math that is a thousand blocks, checked again on every
 * frame the page moves. A page turn moves it every frame, and on the tablet
 * those checks were 20-46 ms of each; a burst of quick turns ran at 5-7 fps.
 * Shown the same way by hand (blocks near the spread `visible`, the rest
 * `hidden`, which needs no observer), the same burst ran at about 40.
 *
 * In Pages reading only the open spread and its neighbours can be seen, so
 * that is what is shown. Each block keeps its recorded height either way
 * (`contain-intrinsic-size`), so nothing on the page moves. Scroll reading
 * keeps `auto`; `releaseLazyBlocks` puts it back.
 */

/** Pages either side of the open one that must be drawn before it shows: its spread and one either side. */
const NEAR_BACK = 2;
const NEAR_AHEAD = 4;
/** Pages drawn once the hand rests: room for a few quick turns either way before the next update. */
const WIDE_BACK = 4;
const WIDE_AHEAD = 8;

/** Where each lazy block sits, in the slot's own units, taken once per layout. */
interface LazyLayout {
  parent: Element;
  count: number;
  width: number;
  height: number;
  blocks: HTMLElement[];
  tops: number[];
  bottoms: number[];
}

const layouts = new WeakMap<HTMLElement, LazyLayout>();
const pending = new WeakMap<HTMLElement, () => void>();

function isLazy(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && el.style.containIntrinsicSize !== "";
}

/**
 * The lazy blocks under `slot`, top to bottom, with where they sit.
 *
 * Blocks keep their height whether shown, hidden or skipped, so this holds
 * until the note reflows: a new render, another column width or height.
 */
function lazyLayout(slot: HTMLElement): LazyLayout | null {
  const first = slot.querySelector<HTMLElement>('[style*="contain-intrinsic-size"]');
  const parent = first?.parentElement;
  if (!parent) return null;
  const width = slot.offsetWidth;
  const height = slot.offsetHeight;
  const known = layouts.get(slot);
  if (known && known.parent === parent && known.count === parent.childElementCount && known.width === width && known.height === height) {
    return known;
  }
  const slotRect = slot.getBoundingClientRect();
  const scale = width > 0 && slotRect.width > 0 ? slotRect.width / width : 1;
  const layout: LazyLayout = { parent, count: parent.childElementCount, width, height, blocks: [], tops: [], bottoms: [] };
  for (const el of Array.from(parent.children)) {
    if (!isLazy(el)) continue;
    const box = el.getBoundingClientRect();
    layout.blocks.push(el);
    layout.tops.push((box.top - slotRect.top) / scale);
    layout.bottoms.push((box.bottom - slotRect.top) / scale);
  }
  layouts.set(slot, layout);
  return layout;
}

/**
 * Draw a lazy block by hand, bounded as `auto` bounded it.
 *
 * `auto` carries paint containment, and a block shown `visible` loses it.
 * Without it a hit test (four on each touch, and one a second from Chromium
 * while frames run) walks every positioned piece of every formula shown: 9-17
 * ms each on the tablet with a dozen pages of math drawn. A stacking context
 * clipped to the block's box gives the bound back, so a hit test skips a block
 * it misses, about a third cheaper. Neither property moves anything: margins
 * collapse as before, where `contain: paint` would move page breaks. The clip
 * is the one scroll reading draws these blocks with, and they were checked
 * not to overflow (`measureSkippableHeights`).
 */
function drawBlock(el: HTMLElement): void {
  el.style.contentVisibility = "visible";
  if (el.style.isolation === "isolate") return;
  el.style.isolation = "isolate";
  el.style.overflow = "clip";
}

/** Show the lazy blocks between `top` and `bottom` (slot units) and hide the rest. How many changed. */
export function showLazyBlocksBetween(slot: HTMLElement, top: number, bottom: number): number {
  const layout = lazyLayout(slot);
  if (!layout) return 0;
  let changed = 0;
  layout.blocks.forEach((el, i) => {
    const show = layout.bottoms[i]! >= top && layout.tops[i]! <= bottom;
    if (el.style.contentVisibility === (show ? "visible" : "hidden")) return;
    if (show) drawBlock(el);
    else el.style.contentVisibility = "hidden";
    changed += 1;
  });
  return changed;
}

/** Show the lazy blocks between `top` and `bottom` that are not shown yet, hiding none. How many changed. */
function revealLazyBlocksBetween(slot: HTMLElement, top: number, bottom: number): number {
  const layout = lazyLayout(slot);
  if (!layout) return 0;
  let changed = 0;
  layout.blocks.forEach((el, i) => {
    if (layout.bottoms[i]! < top || layout.tops[i]! > bottom || el.style.contentVisibility === "visible") return;
    drawBlock(el);
    changed += 1;
  });
  return changed;
}

/** Back to `auto`, for scroll reading or another document. */
export function releaseLazyBlocks(slot: HTMLElement): void {
  pending.get(slot)?.();
  pending.delete(slot);
  const layout = layouts.get(slot);
  const blocks = layout ? layout.blocks : Array.from(slot.querySelectorAll<HTMLElement>('[style*="contain-intrinsic-size"]'));
  for (const el of blocks) {
    if (!el.isConnected) continue;
    if (el.style.contentVisibility !== "auto") el.style.contentVisibility = "auto";
    if (el.style.isolation === "isolate") {
      el.style.removeProperty("isolation");
      el.style.removeProperty("overflow");
    }
  }
  layouts.delete(slot);
}

/** Run `work` when the main thread is free; returns how to call it off. */
export type LaterFn = (work: () => void) => () => void;

const whenIdle: LaterFn = (work) => {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(work, { timeout: 600 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(work, 200);
  return () => window.clearTimeout(id);
};

/**
 * The open page is at `at` (slot units), pages `pageH` high: draw what can be
 * seen from it.
 *
 * Its spread and the one either side are drawn now, the parts of them that
 * are hidden: on the first page shown or after a jump, all of it; on a run
 * of quick turns, the spread after the next. Only those, and nothing hidden:
 * the frame a turn lands is the one the quick turns can least afford, and
 * drawing the whole wider window there, a dozen pages of math every second
 * or third turn, was its slowest part. The wider window, and hiding what
 * fell out of it, wait for the main thread to be free.
 */
export function placeLazyWindow(slot: HTMLElement, at: number, pageH: number, later: LaterFn = whenIdle): void {
  if (!(pageH > 0) || !Number.isFinite(at)) return;
  pending.get(slot)?.();
  pending.delete(slot);
  const wide = () => showLazyBlocksBetween(slot, at - WIDE_BACK * pageH, at + WIDE_AHEAD * pageH);
  revealLazyBlocksBetween(slot, at - NEAR_BACK * pageH, at + NEAR_AHEAD * pageH);
  const cancel = later(() => {
    pending.delete(slot);
    wide();
  });
  pending.set(slot, cancel);
}

/**
 * Copies of the page, live under a turning sheet or in a picture, are drawn
 * whole: a block hidden on the board, or left to `auto` and its observer,
 * would be blank or watched in the copy. Bounded too: a turn's copies are hit
 * tested on every touch of a flick.
 */
export function drawLazyBlocksIn(copy: Element): void {
  copy.querySelectorAll<HTMLElement>('[style*="content-visibility"]').forEach((el) => {
    if (el.style.contentVisibility !== "visible" || el.style.isolation !== "isolate") drawBlock(el);
  });
}
