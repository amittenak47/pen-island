import { HoldButton } from "../components/HoldButton";
import { LIBRARY_HOLD_MS } from "../util/gesture";
import { toggleReadingFullscreen, useReadingFullscreenOn } from "../util/readingFullscreenStore";

/** Crosshair in a frame — "put the page back where it belongs". */
function RecentreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-icon="recenter">
      <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

/** The frame's corners turned inward: leave full screen. */
function ExitFullscreenIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-icon="exit-fullscreen">
      <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
    </svg>
  );
}

/**
 * Tap recenters the page. Hold hides the app header (and the window's or the
 * tablet's system bars) for reading; hold again brings them back.
 */
export function RecenterFullscreenButton({ fullscreen, onRecenter, onToggleFullscreen }: {
  fullscreen: boolean;
  onRecenter: () => void;
  onToggleFullscreen: () => void;
}) {
  return (
    <HoldButton
      label="Full screen"
      holdMs={LIBRARY_HOLD_MS}
      className={["lc-lined-toggle lc-tip-target lc-hold-icon lc-recenter-fullscreen", fullscreen ? "is-active" : ""].filter(Boolean).join(" ")}
      ariaLabel={fullscreen ? "Hold to exit full screen. Tap to recenter" : "Recenter and refresh the view. Hold for full screen"}
      dataTip={fullscreen ? "Hold to exit full screen" : "Recenter · hold for full screen"}
      pressed={fullscreen}
      onTap={onRecenter}
      onConfirm={onToggleFullscreen}
    >
      <span className="lc-recenter-fullscreen-icon" key={fullscreen ? "exit" : "enter"}>
        {fullscreen ? <ExitFullscreenIcon /> : <RecentreIcon />}
      </span>
    </HoldButton>
  );
}

/** The menu toolbar's button, wired to the app-wide full-screen store. Only this re-renders on a toggle. */
export function RecenterFullscreenControl({ onRecenter }: { onRecenter: () => void }) {
  const fullscreen = useReadingFullscreenOn();
  return <RecenterFullscreenButton fullscreen={fullscreen} onRecenter={onRecenter} onToggleFullscreen={toggleReadingFullscreen} />;
}
