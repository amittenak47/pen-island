import { useEffect, useState } from "react";

/**
 * Keep something mounted while it animates out.
 *
 * `mounted` stays true for `exitMs` after `visible` turns false, with
 * `leaving` set so CSS can play the exit; reduced motion skips the wait.
 */
export function usePresence(visible: boolean, exitMs = 140): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) { setMounted(true); return; }
    // No media queries (a test DOM) means nothing is drawn, so nothing to wait for.
    const still = typeof window === "undefined" || !window.matchMedia || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) { setMounted(false); return; }
    const timer = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(timer);
  }, [visible, exitMs]);
  return { mounted: visible || mounted, leaving: !visible && mounted };
}
