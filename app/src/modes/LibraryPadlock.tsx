import type { ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
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
 */
export function PadlockReveal({ shown, children }: { shown: boolean; children: ReactNode }) {
  return <AnimatePresence initial={false}>
    {shown && <Guarded key="guarded">{children}</Guarded>}
  </AnimatePresence>;
}

function Guarded({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  // Locked is locked at once: the trash cannot be used while it slides away.
  const present = useIsPresent();
  return <motion.span className="lc-padlock-reveal" inert={!present} aria-hidden={present ? undefined : true}
    initial={reduced ? false : { width: 0, opacity: 0, x: 12 }}
    animate={{ width: "auto", opacity: 1, x: 0 }}
    exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { width: 0, opacity: 0, x: 12 }}
    transition={{ duration: reduced ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}>
    {children}
  </motion.span>;
}
