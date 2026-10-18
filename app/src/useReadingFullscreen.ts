import { useCallback, useEffect, useRef, useState } from "react";
import { applyReadingFullscreen } from "./util/readingFullscreen";

/**
 * Reading full screen: the app header hides, and the window (desktop) or the
 * status and navigation bars (tablet) follow. `available` is false wherever
 * nothing on screen offers the way back (Home), which leaves full screen.
 */
export function useReadingFullscreen(available: boolean): { on: boolean; toggle: () => void; exit: () => void } {
  const [on, setOn] = useState(false);
  const applied = useRef(false);
  const toggle = useCallback(() => setOn(value => !value), []);
  const exit = useCallback(() => setOn(false), []);
  useEffect(() => {
    // Nothing native until the reader asks; then follow every change.
    if (!on && !applied.current) return;
    applied.current = true;
    void applyReadingFullscreen(on).catch(() => {});
  }, [on]);
  useEffect(() => { if (!available) setOn(false); }, [available]);
  useEffect(() => {
    if (!on) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOn(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on]);
  return { on, toggle, exit };
}
