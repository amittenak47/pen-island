import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, useAnimate, usePresence, useReducedMotion } from "motion/react";
import "./libraryPadlock.css";

/**
 * Lock toggle on a saved library row. Locked rows keep their trash hidden.
 */

export function LibraryPadlock({
  name,
  locked = false,
  disabled = false,
  className,
  onToggle,
}: {
  name: string;
  locked?: boolean;
  disabled?: boolean;
  className?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={["lc-scratch-load-lock", locked && "is-locked", className].filter(Boolean).join(" ")}
      disabled={disabled}
      aria-pressed={locked}
      aria-label={locked ? `Unlock ${name}` : `Lock ${name}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {locked ? (
          <>
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </>
        ) : (
          <>
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0" />
          </>
        )}
      </svg>
    </button>
  );
}

/**
 * What the padlock guards (a row's trash): it slides out and folds away as
 * the row locks, and slides back in as it unlocks. The row's other controls
 * move over with the fold rather than jumping.
 *
 * The row's gap folds with it. Folding only the width left the gap until the
 * trash was removed, so the slide stopped short and then jumped the last
 * few pixels (and unlocking jumped first, then slid).
 */
export function PadlockReveal({ shown, children }: { shown: boolean; children: ReactNode }) {
  // Only a change slides: a row that opens locked or unlocked just is.
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  return <AnimatePresence initial={false}>
    {shown && <Guarded key="guarded" slideIn={mounted.current}>{children}</Guarded>}
  </AnimatePresence>;
}

// Even in and out: a front-loaded curve did most of the fold in its first
// frame and then crawled, which read as a jump.
const SLIDE = { duration: 0.24, ease: [0.4, 0, 0.2, 1] as const };

function rowGap(el: HTMLElement): number {
  return el.parentElement ? Number.parseFloat(getComputedStyle(el.parentElement).columnGap) || 0 : 0;
}

function Guarded({ children, slideIn }: { children: ReactNode; slideIn: boolean }) {
  const reduced = useReducedMotion();
  const [present, safeToRemove] = usePresence();
  const [scope, animate] = useAnimate<HTMLSpanElement>();
  // In: from no width and no gap, before the first paint so it never flashes open.
  useLayoutEffect(() => {
    const el = scope.current;
    if (!el || !slideIn || reduced) return;
    const gap = rowGap(el), width = el.scrollWidth;
    Object.assign(el.style, { width: "0px", marginLeft: `${-gap}px`, opacity: "0" });
    void animate(el, { width: [0, width], marginLeft: [-gap, 0], opacity: [0, 1], x: [12, 0] }, SLIDE)
      .then(() => { el.style.width = ""; el.style.marginLeft = ""; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Out: width and gap together, then gone. Started before the next paint, so
  // the trash never sits still for a frame after the padlock has locked.
  useLayoutEffect(() => {
    if (present) return;
    const el = scope.current;
    if (!el || reduced) { safeToRemove?.(); return; }
    const gap = rowGap(el);
    void animate(el, { width: [el.offsetWidth, 0], marginLeft: [0, -gap], opacity: [1, 0], x: [0, 12] }, SLIDE)
      .then(() => safeToRemove?.());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present]);
  // Locked is locked at once: the trash cannot be used while it slides away.
  return <span ref={scope} className="lc-padlock-reveal" inert={!present} aria-hidden={present ? undefined : true}>
    {children}
  </span>;
}
