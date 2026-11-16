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
/**
 * And then out to these, a rest later: a run of quick turns from a rest draws
 * nothing as it lands for six turns on or three back. Each landing that did
 * (two pages, every one past the second of a run) cost 40-45 ms of style,
 * layout and pre-paint on the tablet, in the next flick's first frame. Drawn
 * blocks past the screen cost little after: none of them is painted, and a
 * hit test passes each by its bounds (`drawBlock`).
 */
const FAR_BACK = 8;
const FAR_AHEAD = 16;

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

/** Hide the lazy blocks outside `top` to `bottom`, drawing none. How many changed. */
function hideLazyBlocksOutside(slot: HTMLElement, top: number, bottom: number): number {
  const layout = lazyLayout(slot);
  if (!layout) return 0;
  let changed = 0;
  layout.blocks.forEach((el, i) => {
    if ((layout.bottoms[i]! >= top && layout.tops[i]! <= bottom) || el.style.contentVisibility === "hidden") return;
    el.style.contentVisibility = "hidden";
    changed += 1;
  });
  return changed;
}

/** Back to `auto`, for another document, or for scroll reading to window again (`followScrollWindow`). */
export function releaseLazyBlocks(slot: HTMLElement): void {
  pending.get(slot)?.();
  pending.delete(slot);
  dropScrollWindow(slot);
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

/**
 * How long the hand must have been off the glass before the wider window is
 * drawn. A hand flicking through presses again well inside this.
 */
const REST_MS = 800;
/** A pointer reported down this long with nothing since lost its lift. */
const STUCK_MS = 5000;

/** Pointers on the glass now, and when one last went down or came up. */
const pressed = new Set<number>();
let pressedAt = -Infinity;
if (typeof window !== "undefined") {
  const opts = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", (event) => {
    pressed.add(event.pointerId);
    pressedAt = performance.now();
  }, opts);
  const lift = (event: PointerEvent) => {
    // A page turn ends the board's own gesture with a pointercancel of its
    // own, the finger still down and turning the sheet.
    if (event.type === "pointercancel" && !event.isTrusted) return;
    pressed.delete(event.pointerId);
    pressedAt = performance.now();
  };
  window.addEventListener("pointerup", lift, opts);
  window.addEventListener("pointercancel", lift, opts);
  window.addEventListener("blur", () => pressed.clear());
}

/**
 * Run `work` once the hand has rested `REST_MS` and the main thread is free.
 *
 * Free alone was too soon. Between two quick turns there is idle time, and
 * the wider window drawn there (a few blocks shown, a few hidden: 1-2 ms of
 * script) cost the next frame 57-92 ms of style, layout and pre-paint on the
 * tablet, the frame the next flick's sheet should have lifted in.
 */
const whenRested: LaterFn = (work) => {
  const since = performance.now();
  let timer = 0;
  let idle = 0;
  const wait = () => {
    const now = performance.now();
    const quiet = now - Math.max(since, pressedAt);
    const up = pressed.size === 0 || now - pressedAt >= STUCK_MS;
    return quiet >= REST_MS && up ? 0 : Math.max(50, REST_MS - quiet);
  };
  const check = () => {
    timer = 0;
    const left = wait();
    if (left > 0) {
      timer = window.setTimeout(check, left);
      return;
    }
    const run = () => {
      idle = 0;
      // A press while it waited for the main thread starts the rest over.
      if (wait() > 0) check();
      else work();
    };
    idle = typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback(run, { timeout: 600 })
      : window.setTimeout(run, 0);
  };
  timer = window.setTimeout(check, REST_MS);
  return () => {
    window.clearTimeout(timer);
    if (!idle) return;
    if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
    else window.clearTimeout(idle);
  };
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
 * fell out of it, wait for the hand to rest (`whenRested`); the far window
 * waits for the next rest, so that no frame draws both.
 */
export function placeLazyWindow(slot: HTMLElement, at: number, pageH: number, later: LaterFn = whenRested): void {
  if (!(pageH > 0) || !Number.isFinite(at)) return;
  pending.get(slot)?.();
  pending.delete(slot);
  dropScrollWindow(slot);
  revealLazyBlocksBetween(slot, at - NEAR_BACK * pageH, at + NEAR_AHEAD * pageH);
  const far = () => {
    pending.delete(slot);
    revealLazyBlocksBetween(slot, at - FAR_BACK * pageH, at + FAR_AHEAD * pageH);
  };
  const wide = () => {
    hideLazyBlocksOutside(slot, at - FAR_BACK * pageH, at + FAR_AHEAD * pageH);
    revealLazyBlocksBetween(slot, at - WIDE_BACK * pageH, at + WIDE_AHEAD * pageH);
    pending.set(slot, later(far));
  };
  pending.set(slot, later(wide));
}

/**
 * Scroll reading, in screens (the view's own height): drawn either side of
 * the view at all times; when the view comes this close to the edge of what
 * is drawn, `SCROLL_AHEAD` more go in at once.
 *
 * Left to `auto`, Blink checked every lazy block on every frame the page
 * moved (4-5 ms a frame on the tablet) and drew each one as it came within
 * reach: on a chapter of math about every 210 px, 25-40 ms of layout,
 * pre-paint and paint in one frame, eight of them a fling (36-47 fps).
 */
const SCROLL_NEAR = 1;
/** Drawn ahead, the way the view is going, whenever the near window runs out: a fling's worth and more, one frame's work. */
const SCROLL_AHEAD = 3;
/** Once the view has rested: room for a few flings either way before the next update. */
const SCROLL_WIDE_BACK = 3;
const SCROLL_WIDE_AHEAD = 5;
/** And then out to these, a rest later. Blocks past them are hidden at each rest. */
const SCROLL_FAR_BACK = 6;
const SCROLL_FAR_AHEAD = 10;

interface ScrollWindow {
  /** What is known drawn around the view, in slot units. */
  lo: number;
  hi: number;
  top: number;
  bottom: number;
  /** The way the view last moved: 1 down the note, -1 up. */
  dir: 1 | -1;
  movedAt: number;
  /** 0: windows the near view only; 1: the wide window is drawn; 2: the far one too. */
  stage: 0 | 1 | 2;
  timer: number;
  idle: number;
}

const scrollWindows = new WeakMap<HTMLElement, ScrollWindow>();
/** A slot found with no lazy blocks, not searched again before this time: each placement would walk the note. */
const noLazyUntil = new WeakMap<HTMLElement, number>();

function dropScrollWindow(slot: HTMLElement): void {
  const w = scrollWindows.get(slot);
  if (!w) return;
  window.clearTimeout(w.timer);
  cancelIdle(w.idle);
  scrollWindows.delete(slot);
}

function cancelIdle(handle: number): void {
  if (!handle) return;
  if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(handle);
  else window.clearTimeout(handle);
}

/**
 * Scroll reading: the view is `top` to `bottom` (slot units). Draw what can
 * be seen from it before it is seen, and hide what is far, as Pages reading
 * does (`placeLazyWindow`): no block is left to `auto` and its observer.
 *
 * Called with every placement of the page, moving or not. A screen either
 * side is always drawn; when the view runs past that, three screens ahead
 * go in at once, in the frame that needs them, then nothing more for two
 * screens of travel. Wider windows, and hiding what fell out of them, wait
 * for the view to rest (no movement and no finger on the glass for
 * `REST_MS`).
 */
export function followScrollWindow(slot: HTMLElement, top: number, bottom: number): void {
  const h = bottom - top;
  if (!(h > 0) || !Number.isFinite(top) || !Number.isFinite(bottom)) return;
  const now = performance.now();
  let w = scrollWindows.get(slot);
  if (!w) {
    // The first placement: the near view drawn, every other block hidden now.
    if ((noLazyUntil.get(slot) ?? -Infinity) > now) return;
    if (!lazyLayout(slot)) {
      noLazyUntil.set(slot, now + 1000);
      return;
    }
    const lo = top - SCROLL_NEAR * h;
    const hi = bottom + SCROLL_NEAR * h;
    showLazyBlocksBetween(slot, lo, hi);
    w = { lo, hi, top, bottom, dir: 1, movedAt: now, stage: 0, timer: 0, idle: 0 };
    scrollWindows.set(slot, w);
    armScrollRest(slot, w);
    return;
  }
  if (top === w.top && bottom === w.bottom) return;
  if (top !== w.top) w.dir = top > w.top ? 1 : -1;
  w.top = top;
  w.bottom = bottom;
  w.movedAt = now;
  w.stage = 0;
  cancelIdle(w.idle);
  w.idle = 0;
  if (top - SCROLL_NEAR * h < w.lo || bottom + SCROLL_NEAR * h > w.hi) {
    const lo = top - (w.dir < 0 ? SCROLL_AHEAD : SCROLL_NEAR) * h;
    const hi = bottom + (w.dir > 0 ? SCROLL_AHEAD : SCROLL_NEAR) * h;
    revealLazyBlocksBetween(slot, lo, hi);
    // A jump past what is drawn starts a new run; blocks left behind go at the next rest.
    const joins = lo <= w.hi && hi >= w.lo;
    w.lo = joins ? Math.min(w.lo, lo) : lo;
    w.hi = joins ? Math.max(w.hi, hi) : hi;
  }
  armScrollRest(slot, w);
}

/** Widen the scroll window once the view has rested; again at the next rest. */
function armScrollRest(slot: HTMLElement, w: ScrollWindow): void {
  if (w.timer || w.idle || w.stage >= 2) return;
  const wait = () => {
    const now = performance.now();
    const quiet = now - Math.max(w.movedAt, pressedAt);
    const up = pressed.size === 0 || now - pressedAt >= STUCK_MS;
    return quiet >= REST_MS && up ? 0 : Math.max(50, REST_MS - quiet);
  };
  const check = () => {
    w.timer = 0;
    if (scrollWindows.get(slot) !== w) return;
    const left = wait();
    if (left > 0) {
      w.timer = window.setTimeout(check, left);
      return;
    }
    const run = () => {
      w.idle = 0;
      if (scrollWindows.get(slot) !== w) return;
      // Moved or touched while it waited for the main thread: rest again.
      if (wait() > 0) {
        armScrollRest(slot, w);
        return;
      }
      // Screens up the note and down it, `ahead` the way the view last went.
      const h = w.bottom - w.top;
      const up = (behind: number, ahead: number) => w.top - (w.dir > 0 ? behind : ahead) * h;
      const down = (behind: number, ahead: number) => w.bottom + (w.dir > 0 ? ahead : behind) * h;
      if (w.stage === 0) {
        hideLazyBlocksOutside(slot, up(SCROLL_FAR_BACK, SCROLL_FAR_AHEAD), down(SCROLL_FAR_BACK, SCROLL_FAR_AHEAD));
        w.lo = up(SCROLL_WIDE_BACK, SCROLL_WIDE_AHEAD);
        w.hi = down(SCROLL_WIDE_BACK, SCROLL_WIDE_AHEAD);
        w.stage = 1;
      } else {
        w.lo = up(SCROLL_FAR_BACK, SCROLL_FAR_AHEAD);
        w.hi = down(SCROLL_FAR_BACK, SCROLL_FAR_AHEAD);
        w.stage = 2;
      }
      revealLazyBlocksBetween(slot, w.lo, w.hi);
      // The rest starts over for the next step.
      w.movedAt = performance.now();
      armScrollRest(slot, w);
    };
    w.idle = typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback(run, { timeout: 600 })
      : window.setTimeout(run, 0);
  };
  w.timer = window.setTimeout(check, Math.max(50, REST_MS - (performance.now() - w.movedAt)));
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
