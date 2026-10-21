import type { ReactNode, Ref } from "react";
import { motion, useIsPresent, useReducedMotion } from "motion/react";
import { useDialogButtonPress } from "./useDialogButtonPress";
import "./dialogFrame.css";

export type DialogShape = "soft" | "blocky";
export type DialogMode = "practice" | "annotate" | "whiteboard" | "browse" | "explore";

/** Opt-in presentation only; each dialog keeps its own lifecycle and actions. */
export function DialogFrame({
  titleId,
  title,
  subtitle,
  icon,
  description,
  mode,
  shape = "soft",
  className = "",
  onClose,
  closeDisabled = false,
  inert = false,
  exiting = false,
  ref,
  ariaLabel,
  children,
}: {
  titleId: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  description?: string;
  mode?: DialogMode;
  shape?: DialogShape;
  className?: string;
  onClose?: () => void;
  closeDisabled?: boolean;
  inert?: boolean;
  exiting?: boolean;
  ref?: Ref<HTMLDivElement>;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const buttonPress = useDialogButtonPress();
  return (
    <motion.div
      ref={ref}
      className={`lc-settings-modal lc-dialog-frame ${className}`}
      data-dialog-shape={shape}
      data-dialog-mode={mode}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={titleId}
      aria-describedby={description ? `${titleId}-description` : undefined}
      inert={inert || exiting || !present}
      aria-hidden={inert || exiting || !present || undefined}
      /*
       * One `transform`, not `y` and `scale`: Motion drives separate transform
       * values from the main thread, frame by frame, and opening a dialog is
       * exactly when that thread is busy rendering it (Settings renders twice
       * as it opens). A whole transform goes to the compositor, which keeps
       * its frames whatever the page is doing.
       */
      initial={reduced ? false : { opacity: 0, transform: "translateY(12px) scale(0.965)" }}
      animate={{ opacity: exiting ? 0 : 1, transform: exiting ? "translateY(8px) scale(0.975)" : "translateY(0px) scale(1)" }}
      exit={{ opacity: 0, transform: "translateY(8px) scale(0.975)", transition: { duration: reduced || exiting ? 0 : 0.18 } }}
      transition={{ duration: reduced ? 0 : exiting ? 0.18 : 0.24, ease: [0.22, 1, 0.36, 1] }}
      {...buttonPress}
    >
      <header className="lc-dialog-head">
        <div className="lc-dialog-heading">
          <span className="lc-dialog-chip" aria-hidden="true">{icon}</span>
          <div className="lc-dialog-heading-text">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p className="lc-dialog-meta">{subtitle}</p>}
          </div>
          {onClose && <button
            type="button"
            className="lc-dialog-close"
            aria-label={`Close ${title}`}
            disabled={closeDisabled}
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>}
        </div>
        {description ? <p id={`${titleId}-description`} className="lc-dialog-description">{description}</p> : null}
      </header>
      {children}
    </motion.div>
  );
}
