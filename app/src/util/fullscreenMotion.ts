import { announceSplitResize } from "./splitResize";

/** Same CSS clip/transform transition as the mobile agent sheet. */
const DURATION = 240;
/**
 * Two phases. Entering: the header's box closes, then the page expands.
 * Leaving: the page shrinks, then the header's box opens into the room left.
 * The second phase starts as the first is landing.
 */
const STAGGER = 200;
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
  const before = main?.getBoundingClientRect();
  const page = main ? pageAtCentre(main) : null;
  const pageBefore = page?.getBoundingClientRect();
  const clip = header ? getComputedStyle(header).clipPath : "";
  // Measure the interrupted transition before removing it, and resolve its
  // promise without releasing the hold or fitting the obsolete geometry.
  running?.cancel();
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!header || !main || !before?.height || reduced) {
    changeLayout();
    settle();
    return Promise.resolve();
  }

  const original = { clip: header.style.clipPath, transform: main.style.transform, origin: main.style.transformOrigin };
  document.body.dataset.lcPanelMotion = "true";
  app.dataset.fullscreenMotion = "prepare";
  header.style.clipPath = clip && clip !== "none" ? clip : entering ? OPEN : CLOSED;
  main.style.transform = "none";
  main.style.transformOrigin = "50% 0px";
  changeLayout();
  // Fit the final geometry now, untransformed, so the motion ends on the
  // fitted page. Fitting after the motion snapped the page once it stopped.
  delete document.body.dataset.lcPanelMotion;
  announceSplitResize("settle");
  document.body.dataset.lcPanelMotion = "true";
  const after = main.getBoundingClientRect();
  const restore = () => {
    app.dataset.fullscreenMotion = "prepare";
    header.style.clipPath = original.clip;
    header.style.removeProperty("transition-delay");
    main.style.removeProperty("transition-delay");
    main.style.transform = original.transform;
    main.style.transformOrigin = original.origin;
    // As with useAgentSheet's drag cleanup, commit the restored styles while
    // transitions are off, so removing the guard cannot replay an old clip.
    void getComputedStyle(header).clipPath;
    void getComputedStyle(main).transform;
    delete app.dataset.fullscreenMotion;
  };
  if (!after.height) {
    restore();
    settle();
    return Promise.resolve();
  }
  // Map what is on screen back onto where it was. A document page: the board
  // has already refitted it, so translate and scale it uniformly from its new
  // box onto its old one (exact whether the page fits the width or the
  // height). Anything else: the reading box itself, height only.
  const pageAfter = page?.isConnected ? page.getBoundingClientRect() : null;
  let rest = "translateY(0px) scaleY(1)";
  if (pageBefore?.width && pageAfter?.width) {
    const scale = pageBefore.width / pageAfter.width;
    const centre = { x: pageAfter.left + pageAfter.width / 2, y: pageAfter.top + pageAfter.height / 2 };
    const dx = pageBefore.left + pageBefore.width / 2 - centre.x;
    const dy = pageBefore.top + pageBefore.height / 2 - centre.y;
    main.style.transformOrigin = `${centre.x - after.left}px ${centre.y - after.top}px`;
    main.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    rest = "translate(0px, 0px) scale(1)";
  } else {
    main.style.transform = `translateY(${before.top - after.top}px) scaleY(${before.height / after.height})`;
  }
  // Establish the CSS before-change style now: the next frame paints the old
  // box, never the final one.
  void getComputedStyle(header).clipPath;
  void getComputedStyle(main).transform;

  return new Promise<void>(resolve => {
    let timer = 0, startFrame = 0, startTimer = 0, started = false;
    const pending = new Set<HTMLElement>([header, main]);
    const finish = (cancelled: boolean) => {
      if (running !== current) return;
      running = null;
      window.clearTimeout(timer);
      window.cancelAnimationFrame(startFrame);
      window.clearTimeout(startTimer);
      header.removeEventListener("transitionend", onEnd);
      main.removeEventListener("transitionend", onEnd);
      restore();
      if (!cancelled) settle();
      resolve();
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === header && event.propertyName === "clip-path") pending.delete(header);
      if (event.target === main && event.propertyName === "transform") pending.delete(main);
      if (!pending.size) finish(false);
    };
    const current = { cancel: () => finish(true) };
    running = current;
    header.addEventListener("transitionend", onEnd);
    main.addEventListener("transitionend", onEnd);
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
      main.style.transitionDelay = entering ? `${STAGGER}ms` : "0ms";
      header.style.clipPath = entering ? CLOSED : OPEN;
      main.style.transform = rest;
      // WebView can omit transitionend (e.g. a backgrounded window). Also covers
      // a reversal before either property has moved and has nothing to animate.
      timer = window.setTimeout(() => finish(false), STAGGER + DURATION + 20);
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
