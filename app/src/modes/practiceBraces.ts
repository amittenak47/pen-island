/**
 * Practice's outer braces move continuously between states. Each hover change
 * starts from wherever the braces are at that instant (mid-idle, mid-open or
 * mid-close) and heads for the new target, taking time in proportion to the
 * distance left. CSS still runs the resting idle loop.
 */

const OPEN_X = 28;
const OPEN_MS = 1600;
const CLOSE_MS = 800;
/** Leave first selects and deletes any written code, then closes. */
const DELETE_MS = 450;
const SLASH_FADE_MS = 450;
const MIN_MS = 120;

type Parts = { left: SVGElement; right: SVGElement; slash: SVGElement };

export type PracticeBraces = {
  /** Opens from the current pose; returns how long until fully open (ms). */
  open(): number;
  /** Closes from the current pose; returns how long until fully closed (ms). */
  close(codeWritten: boolean): number;
  /** Hands the braces back to the stylesheet's idle loop. */
  release(): void;
};

export function createPracticeBraces(card: HTMLElement): PracticeBraces | null {
  const left = card.querySelector<SVGElement>(".lc-home-bra-l");
  const right = card.querySelector<SVGElement>(".lc-home-bra-r");
  const slash = card.querySelector<SVGElement>(".lc-home-slash");
  if (!left || !right || !slash || typeof left.animate !== "function" || typeof DOMMatrixReadOnly === "undefined") return null;
  const parts: Parts = { left, right, slash };
  let running: Animation[] = [];

  const offset = (el: SVGElement) => {
    try { return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41; } catch { return 0; }
  };
  const opacity = (el: SVGElement) => {
    const value = Number(getComputedStyle(el).opacity);
    return Number.isFinite(value) ? value : 1;
  };

  /** Reads the live pose, then stops whatever was moving the braces. */
  function capture() {
    const pose = { left: offset(parts.left), right: offset(parts.right), slash: opacity(parts.slash) };
    for (const animation of running) animation.cancel();
    running = [];
    return pose;
  }

  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return {
    open() {
      const pose = capture();
      if (reduced()) return 0;
      // Fraction of the full opening still to travel, from the further brace.
      const left = Math.min(1, Math.abs(-OPEN_X - pose.left) / OPEN_X);
      const right = Math.min(1, Math.abs(OPEN_X - pose.right) / OPEN_X);
      const ms = Math.max(MIN_MS, OPEN_MS * Math.max(left, right));
      const timing: KeyframeAnimationOptions = { duration: ms, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" };
      running = [
        parts.left.animate([{ transform: `translateX(${pose.left}px)` }, { transform: `translateX(${-OPEN_X}px)` }], timing),
        parts.right.animate([{ transform: `translateX(${pose.right}px)` }, { transform: `translateX(${OPEN_X}px)` }], timing),
        parts.slash.animate([{ opacity: pose.slash }, { opacity: 0 }],
          { duration: Math.max(80, SLASH_FADE_MS * pose.slash), easing: "ease", fill: "forwards" }),
      ];
      return ms;
    },
    close(codeWritten) {
      const pose = capture();
      if (reduced()) return 0;
      const delay = codeWritten ? DELETE_MS : 0;
      const left = Math.min(1, Math.abs(pose.left) / OPEN_X);
      const right = Math.min(1, Math.abs(pose.right) / OPEN_X);
      const ms = Math.max(MIN_MS, CLOSE_MS * Math.max(left, right));
      // fill "both": during the delete pause the braces hold their live pose
      // instead of dropping to the stylesheet's closed default.
      const timing: KeyframeAnimationOptions = { delay, duration: ms, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" };
      running = [
        parts.left.animate([{ transform: `translateX(${pose.left}px)` }, { transform: "translateX(0px)" }], timing),
        parts.right.animate([{ transform: `translateX(${pose.right}px)` }, { transform: "translateX(0px)" }], timing),
        // The slash appears once, as the braces meet.
        parts.slash.animate([{ opacity: pose.slash }, { opacity: pose.slash, offset: 0.7 }, { opacity: 1 }],
          { ...timing, easing: "linear" }),
      ];
      return delay + ms;
    },
    release() {
      for (const animation of running) animation.cancel();
      running = [];
    },
  };
}
