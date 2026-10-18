import { useIsPresent } from "motion/react";
import { DialogBackdrop } from "./DialogMotion";
/**
 * LLM unreachable while the in-process daemon is up — Settings → LLM, or continue
 * without coach.
 */

import { useEffect } from "react";

import { HoldButton } from "./HoldButton";
import { LIBRARY_HOLD_MS } from "../util/gesture";
import "../modes/libraryMenu.css";
import { LoadingDoodle } from "./LoadingDoodle";
import { DialogFrame } from "./DialogFrame";
import "./confirmationDialogs.css";

export interface LlmStatusDialogProps {
  phase: "enter" | "open" | "exit";
  onOpenSettings: () => void;
  onContinueWithout: () => void;
  /**
   * `firstRun`: the one-time question on a device's first launch ("Use an AI
   * model?"). `offline`: a model was chosen but is not reachable.
   */
  variant?: "offline" | "firstRun";
  /** Offline only: stop asking at startup (Settings → LLM turns it back on). */
  onStopAsking?: () => void;
}

export function LlmStatusDialog({
  phase,
  onOpenSettings,
  onContinueWithout,
  variant = "offline",
  onStopAsking,
}: LlmStatusDialogProps) {
  const firstRun = variant === "firstRun";
  const present = useIsPresent();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && present && phase !== "exit") onContinueWithout();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onContinueWithout, present, phase]);

  return (
    <DialogBackdrop exiting={phase === "exit"}
      className="lc-settings-backdrop lc-server-gate"
      role="presentation"
    >
      <LoadingDoodle nativeInput={present && phase !== "exit"} nativeExclude=".lc-server-gate-modal button, .lc-server-gate-modal .lc-hold-reveal" />
      <DialogFrame exiting={phase === "exit"}
        className="lc-attempt-modal lc-server-gate-modal lc-library-holds lc-llm-status-dialog"
        titleId="lc-llm-status-title"
        title={firstRun ? "Use an AI model?" : "Coach LLM is offline"}
        subtitle={firstRun ? "First launch" : ""}
        ariaLabel={firstRun ? "Use an AI model" : "Coach LLM offline"} shape="blocky"
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M4 3h16v14H8l-4 4V3Z"/><path d="M8 8h8m-8 4h5"/></svg>}
      >
        <div className="lc-settings-choice lc-dialog-body">
          {firstRun ? (
            <p className="lc-settings-hint lc-llm-first-run-hint">
              The agent and coach need one. Ink, reading, sync and tests work without it.
            </p>
          ) : null}
          <HoldButton
            holdMs={LIBRARY_HOLD_MS}
            label={firstRun ? "Set up a model" : "Open Settings"}
            className="lc-hold-choice"
            onConfirm={onOpenSettings}
          >
            {firstRun ? "Set up a model" : "Settings → LLM"}
          </HoldButton>
          <HoldButton
            holdMs={LIBRARY_HOLD_MS}
            label={firstRun ? "Use without AI" : "Continue without LLM"}
            className="lc-hold-choice"
            onConfirm={onContinueWithout}
          >
            {firstRun ? "Use without AI" : "Continue without LLM"}
          </HoldButton>
          {!firstRun && onStopAsking ? (
            <HoldButton
              holdMs={LIBRARY_HOLD_MS}
              label="Don't ask at startup"
              className="lc-hold-choice"
              onConfirm={onStopAsking}
            >
              Don't ask at startup
            </HoldButton>
          ) : null}
        </div>
      </DialogFrame>
    </DialogBackdrop>
  );
}
