import { announceSplitResize } from "./splitResize";

/**
 * Reading full screen as one box motion, like the mobile agent sheet.
 *
 * The layout changes once, before this runs (the root's `data-fullscreen`
 * flips): the header leaves the flow and the reading area takes its height.
 * Boards refit to that final size right away. Then, with nothing laid out per
 * frame:
 * - the header's box closes upward (`clip-path`); its contents stay put, so
 *   nothing slides;
 * - the reading area grows from its old box to the full screen as one uniform
 *   scale, so the page enlarges into place instead of jumping. Leaving runs it
 *   backwards: the header box opens downward and the page shrinks into place.
 *
 * Animating the header's height instead relaid the whole app and refitted the
 * board on every frame, which is what made it choppy.
 */
const DURATION = 240;
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const OPEN = "inset(0px 0px 0px 0px)";
const CLOSED = "inset(0px 0px 100% 0px)";

let running: { animations: Animation[]; timer: number; header: HTMLElement | null } | null = null;

function stopRunning(): void {
  if (!running) return;
  window.clearTimeout(running.timer);
  for (const animation of running.animations) animation.cancel();
  running.header?.style.removeProperty("z-index");
  running = null;
}

/** Call right after the full-screen attribute flips, in the same task, before paint. */
export function animateFullscreenChange(app: HTMLElement, entering: boolean): Promise<void> {
  stopRunning();
  const header = app.querySelector<HTMLElement>(":scope > .lc-header");
  const content = [...app.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== header);
  // Fit the final geometry now, while nothing is transformed.
  announceSplitResize("settle");
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!header || reduced || typeof header.animate !== "function") return Promise.resolve();

  const tall = app.clientHeight;
  const bar = header.offsetHeight;
  if (!tall || !bar || bar >= tall) return Promise.resolve();
  const short = tall - bar;
  // The reading box on screen: [bar, tall] with the header, [0, tall] without.
  // Map the new box onto the old one about its centre; animate to identity.
  const from = entering
    ? { shift: bar / 2, scale: short / tall, centre: tall / 2 }
    : { shift: -bar / 2, scale: tall / short, centre: (tall + bar) / 2 };
  const options: KeyframeAnimationOptions = { duration: DURATION, easing: EASING };
  // The header paints over the enlarged page while it is still open.
  header.style.zIndex = "30";
  const animations = [
    header.animate(entering
      ? [{ clipPath: OPEN, visibility: "visible" }, { clipPath: CLOSED, visibility: "visible" }]
      : [{ clipPath: CLOSED, visibility: "visible" }, { clipPath: OPEN, visibility: "visible" }], options),
    ...content.map(el => {
      const origin = `50% ${from.centre - el.offsetTop}px`;
      return el.animate([
        { transform: `translateY(${from.shift}px) scale(${from.scale})`, transformOrigin: origin },
        { transform: "translateY(0px) scale(1)", transformOrigin: origin },
      ], options);
    }),
  ];
  // A refit mid-motion would measure transformed boxes. Hold refits, then
  // settle once the motion is over.
  document.body.dataset.lcPanelMotion = "true";
  const current = { animations, timer: 0, header };
  running = current;
  return new Promise<void>(resolve => {
    const end = () => {
      if (running !== current) { resolve(); return; }
      running = null;
      header.style.removeProperty("z-index");
      delete document.body.dataset.lcPanelMotion;
      announceSplitResize("settle");
      // Anything else that sizes itself to the window (page-turn's chrome
      // clearance, panels) measures the final geometry once.
      window.dispatchEvent(new Event("resize"));
      resolve();
    };
    void Promise.all(animations.map(animation => animation.finished.catch(() => undefined))).then(() => {
      current.timer = window.setTimeout(end, 0);
    });
  });
}
