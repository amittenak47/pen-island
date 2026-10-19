import { announceSplitResize } from "./splitResize";

/** Same CSS clip/transform transition as the mobile agent sheet. */
const DURATION = 240;
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
/**
 * Two phases. Entering: the header's box closes, then the page expands.
 * Leaving: the page shrinks, then the header's box opens into the room left.
 * The second phase starts as the first is landing.
 */
const STAGGER = 200;
/** When the second phase starts; the store brings the status bar back with it. */
export const FULLSCREEN_STAGGER_MS = STAGGER;
/**
 * Leaving, the page shrinks on a gentler, symmetric curve: the sheet's
 * front-loaded ease-out reads well for a box growing, but shrinking with it
 * snapped. The header also fades in while its box opens.
 */
const EXIT_SHRINK_MS = 280;
const EXIT_SHRINK_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";
/** Two frames this quick in a row mean the board's refit work is done. */
const QUICK_FRAME_MS = 20;
/** Never hold the old picture longer than this before moving. */
const MAX_HOLD_MS = 220;
const OPEN = "inset(0px 0px 0px 0px)";
const CLOSED = "inset(0px 0px 100% 0px)";

let running: { cancel: () => void } | null = null;

/** The document page on screen, if the reading area shows one. */
function pageAtCentre(main: HTMLElement): HTMLElement | null {
  const box = main.getBoundingClientRect();
  if (!box.width || !box.height || typeof document.elementsFromPoint !== "function") return null;
  const hits = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  const page = hits.find(el => el instanceof HTMLElement && el.matches(".lc-pdf-page") && main.contains(el));
  return (page as HTMLElement | undefined) ?? null;
}

function settle(): void {
  delete document.body.dataset.lcPanelMotion;
  announceSplitResize("settle");
  window.dispatchEvent(new Event("resize"));
}

/**
 * Capture the visible box BEFORE the store changes data-fullscreen. Commit
 * the inverse transform and starting clip with transitions off, then change
 * only compositor properties. Both commits happen in this task, before paint:
 * there is no frame of the final layout before its starting transform.
 *
 * The layout changes once. Board refits wait until the transition finishes;
 * neither animation frames nor a React workspace render are involved here.
 */
export function animateFullscreenChange(app: HTMLElement, entering: boolean, changeLayout: () => void): Promise<void> {
  const header = app.querySelector<HTMLElement>(":scope > .lc-header");
  // The portal spans are display:contents, so they have no box to transform.
  // Leave the agent sheet's own transform/clip transition under its control.
  const main = app.querySelector<HTMLElement>(":scope > .lc-main");
  // The page moves: the visible board wrappers (two in a split). The menu
  // toolbar is screen chrome in its own slot. Riding the page's scale it went
  // down, back up and down again; now it moves once, straight from its old
  // place to its new one, in step with the page (or not at all if its place
  // did not change).
  const movers = main ? [...main.children].filter((el): el is HTMLElement =>
    el instanceof HTMLElement && el.classList.contains("lc-canvas-wrap") && getComputedStyle(el).display !== "none") : [];
  const chrome = main?.querySelector<HTMLElement>(":scope > .lc-board-chrome-slot") ?? null;
  const chromeMark = chrome?.firstElementChild instanceof HTMLElement ? chrome.firstElementChild : null;
  const chromeBefore = chromeMark?.getBoundingClientRect();
  const before = movers.map(el => el.getBoundingClientRect());
  const page = main && movers.length === 1 ? pageAtCentre(main) : null;
  const pageBefore = page?.getBoundingClientRect();
  const clip = header ? getComputedStyle(header).clipPath : "";
  // Measure the interrupted transition before removing it, and resolve its
  // promise without releasing the hold or fitting the obsolete geometry.
  running?.cancel();
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!header || !main || !movers.length || before.some(box => !box.height) || reduced) {
    changeLayout();
    settle();
    return Promise.resolve();
  }

  const originals = movers.map(el => ({ transform: el.style.transform, origin: el.style.transformOrigin }));
  const originalClip = header.style.clipPath;
  document.body.dataset.lcPanelMotion = "true";
  app.dataset.fullscreenMotion = "prepare";
  header.style.clipPath = clip && clip !== "none" ? clip : entering ? OPEN : CLOSED;
  if (!entering) header.style.opacity = "0";
  for (const el of movers) {
    el.style.transform = "none";
    el.style.transformOrigin = "50% 0px";
  }
  if (chrome) chrome.style.transform = "none";
  changeLayout();
  // Fit the final geometry now, untransformed, so the motion ends on the
  // fitted page. Fitting after the motion snapped the page once it stopped.
  delete document.body.dataset.lcPanelMotion;
  announceSplitResize("settle");
  document.body.dataset.lcPanelMotion = "true";
  const after = movers.map(el => el.getBoundingClientRect());
  const chromeAfter = chromeMark?.getBoundingClientRect();
  const chromeShift = chromeBefore && chromeAfter
    ? { x: chromeBefore.left - chromeAfter.left, y: chromeBefore.top - chromeAfter.top } : { x: 0, y: 0 };
  const chromeMoves = !!chrome && (Math.abs(chromeShift.x) > 0.5 || Math.abs(chromeShift.y) > 0.5);
  const restore = () => {
    app.dataset.fullscreenMotion = "prepare";
    header.style.clipPath = originalClip;
    header.style.removeProperty("transition-delay");
    header.style.removeProperty("opacity");
    movers.forEach((el, i) => {
      el.style.removeProperty("transition-delay");
      el.style.removeProperty("transition-duration");
      el.style.removeProperty("transition-timing-function");
      el.style.transform = originals[i]!.transform;
      el.style.transformOrigin = originals[i]!.origin;
    });
    if (chrome) {
      chrome.style.removeProperty("transform");
      chrome.style.removeProperty("transition");
    }
    // As with useAgentSheet's drag cleanup, commit the restored styles while
    // transitions are off, so removing the guard cannot replay an old clip.
    void getComputedStyle(header).clipPath;
    for (const el of movers) void getComputedStyle(el).transform;
    delete app.dataset.fullscreenMotion;
  };
  if (after.some(box => !box.height)) {
    restore();
    settle();
    return Promise.resolve();
  }
  // Map what is on screen back onto where it was. A document page: the board
  // has already refitted it, so translate and scale it uniformly from its new
  // box onto its old one (exact whether the page fits the width or the
  // height). Anything else: each board box itself, height only.
  const pageAfter = page?.isConnected ? page.getBoundingClientRect() : null;
  let rest = "translateY(0px) scaleY(1)";
  if (pageBefore?.width && pageAfter?.width) {
    const scale = pageBefore.width / pageAfter.width;
    const centre = { x: pageAfter.left + pageAfter.width / 2, y: pageAfter.top + pageAfter.height / 2 };
    const dx = pageBefore.left + pageBefore.width / 2 - centre.x;
    const dy = pageBefore.top + pageBefore.height / 2 - centre.y;
    const box = after[0]!;
    movers[0]!.style.transformOrigin = `${centre.x - box.left}px ${centre.y - box.top}px`;
    movers[0]!.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    rest = "translate(0px, 0px) scale(1)";
  } else {
    movers.forEach((el, i) => {
      el.style.transform = `translateY(${before[i]!.top - after[i]!.top}px) scaleY(${before[i]!.height / after[i]!.height})`;
    });
  }
  // The toolbar starts where it was.
  if (chrome && chromeMoves) chrome.style.transform = `translate(${chromeShift.x}px, ${chromeShift.y}px)`;
  // Establish the CSS before-change style now: the next frame paints the old
  // box, never the final one.
  void getComputedStyle(header).clipPath;
  for (const el of movers) void getComputedStyle(el).transform;
  if (chrome) void getComputedStyle(chrome).transform;

  return new Promise<void>(resolve => {
    let timer = 0, startFrame = 0, startTimer = 0, started = false;
    const pending = new Set<HTMLElement>([header, ...movers, ...(chrome && chromeMoves ? [chrome] : [])]);
    const finish = (cancelled: boolean) => {
      if (running !== current) return;
      running = null;
      window.clearTimeout(timer);
      window.cancelAnimationFrame(startFrame);
      window.clearTimeout(startTimer);
      header.removeEventListener("transitionend", onEnd);
      for (const el of movers) el.removeEventListener("transitionend", onEnd);
      chrome?.removeEventListener("transitionend", onEnd);
      restore();
      if (!cancelled) settle();
      resolve();
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === header && event.propertyName === "clip-path") pending.delete(header);
      for (const el of movers) if (event.target === el && event.propertyName === "transform") pending.delete(el);
      if (chrome && event.target === chrome && event.propertyName === "transform") pending.delete(chrome);
      if (!pending.size) finish(false);
    };
    const current = { cancel: () => finish(true) };
    running = current;
    header.addEventListener("transitionend", onEnd);
    for (const el of movers) el.addEventListener("transitionend", onEnd);
    chrome?.addEventListener("transitionend", onEnd);
    // The refit above, and the board's follow-up work (redrawing the page
    // sharp at its new size), cost a few frames. The old picture holds until
    // frames are quick again, then the clock starts, so the motion plays in
    // full instead of jumping ahead by that time. Capped, so it never stalls.
    const start = () => {
      if (started || running !== current) return;
      started = true;
      window.cancelAnimationFrame(startFrame);
      window.clearTimeout(startTimer);
      app.dataset.fullscreenMotion = "active";
      header.style.transitionDelay = entering ? "0ms" : `${STAGGER}ms`;
      // The page's phase: second when entering, first when leaving.
      const pageDelay = entering ? STAGGER : 0;
      const pageMs = entering ? DURATION : EXIT_SHRINK_MS;
      const pageEasing = entering ? EASING : EXIT_SHRINK_EASING;
      for (const el of movers) {
        el.style.transitionDelay = `${pageDelay}ms`;
        if (!entering) {
          el.style.transitionDuration = `${EXIT_SHRINK_MS}ms`;
          el.style.transitionTimingFunction = EXIT_SHRINK_EASING;
        }
        el.style.transform = rest;
      }
      if (!entering) header.style.opacity = "1";
      header.style.clipPath = entering ? CLOSED : OPEN;
      if (chrome && chromeMoves) {
        // Once, with the page: same delay, duration and curve.
        chrome.style.transition = `transform ${pageMs}ms ${pageEasing} ${pageDelay}ms`;
        chrome.style.transform = "translate(0px, 0px)";
      }
      // WebView can omit transitionend (e.g. a backgrounded window). Also covers
      // a reversal before either property has moved and has nothing to animate.
      const total = entering ? STAGGER + DURATION : Math.max(EXIT_SHRINK_MS, STAGGER + DURATION);
      timer = window.setTimeout(() => finish(false), total + 20);
    };
    const begun = performance.now();
    let last = begun, quick = 0;
    const watch = (now: number) => {
      quick = now - last < QUICK_FRAME_MS ? quick + 1 : 0;
      last = now;
      if (quick >= 2 || now - begun > MAX_HOLD_MS) start();
      else startFrame = window.requestAnimationFrame(watch);
    };
    startFrame = window.requestAnimationFrame(watch);
    // A hidden page gets no frames: do not hold board refits forever.
    startTimer = window.setTimeout(start, MAX_HOLD_MS + 50);
  });
}
