import { announceSplitResize } from "./splitResize";

/** Same CSS clip/transform transition as the mobile agent sheet. */
const DURATION = 240;
const OPEN = "inset(0px 0px 0px 0px)";
const CLOSED = "inset(0px 0px 100% 0px)";

let running: { cancel: () => void } | null = null;

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
  const after = main.getBoundingClientRect();
  const restore = () => {
    app.dataset.fullscreenMotion = "prepare";
    header.style.clipPath = original.clip;
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
  // Only height changes: preserving the width also avoids a horizontal jump
  // when a transition is reversed from an intermediate box.
  main.style.transform = `translateY(${before.top - after.top}px) scaleY(${before.height / after.height})`;
  // Establish the CSS before-change style without waiting a paint (or two
  // requestAnimationFrames, which would expose the wrong box on WebView).
  void getComputedStyle(header).clipPath;
  void getComputedStyle(main).transform;

  return new Promise<void>(resolve => {
    let timer = 0;
    const pending = new Set<HTMLElement>([header, main]);
    const finish = (cancelled: boolean) => {
      if (running !== current) return;
      running = null;
      window.clearTimeout(timer);
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
    app.dataset.fullscreenMotion = "active";
    header.style.clipPath = entering ? CLOSED : OPEN;
    main.style.transform = "translateY(0px) scaleY(1)";
    // WebView can omit transitionend (e.g. a backgrounded window). Also covers
    // a reversal before either property has moved and has nothing to animate.
    timer = window.setTimeout(() => finish(false), DURATION + 20);
  });
}
