import { useEffect, useState } from "react";

export const HEADER_MODES = [
  ["annotate", "Annotate"], ["whiteboard", "Whiteboard"], ["practice", "Practice"],
  ["web", "Web"], ["explore", "Explore"],
] as const;
export type HeaderMode = typeof HEADER_MODES[number][0];
/**
 * The header's left-to-right order, for Settings to list the switches in.
 * HEADER_MODES keeps its own order: it is the order the choice is saved in.
 */
export const HEADER_MODES_SHOWN: readonly (typeof HEADER_MODES[number])[] =
  (["annotate", "web", "whiteboard", "explore", "practice"] as const).map(mode => HEADER_MODES.find(([m]) => m === mode)!);
export type HeaderModes = Record<HeaderMode, boolean>;
export const HEADER_MODES_EVENT = "lc-header-modes";
const KEY = "whiteboard.headerModes.v1";

export function normalizeHeaderModes(value: unknown): HeaderModes {
  const saved = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(HEADER_MODES.map(([key]) => [key, saved[key] !== false])) as HeaderModes;
}
export function loadHeaderModes(): HeaderModes {
  try { return normalizeHeaderModes(JSON.parse(localStorage.getItem(KEY) || "null")); }
  catch { return normalizeHeaderModes(null); }
}
export function saveHeaderModes(value: HeaderModes): void {
  try { localStorage.setItem(KEY, JSON.stringify(normalizeHeaderModes(value))); }
  catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(HEADER_MODES_EVENT));
}
export function useHeaderModes(): HeaderModes {
  const [value, setValue] = useState(loadHeaderModes);
  useEffect(() => {
    const changed = () => setValue(loadHeaderModes());
    window.addEventListener(HEADER_MODES_EVENT, changed);
    window.addEventListener("storage", changed);
    return () => { window.removeEventListener(HEADER_MODES_EVENT, changed); window.removeEventListener("storage", changed); };
  }, []);
  return value;
}
