import { useSyncExternalStore } from "react";
import { animateFullscreenChange } from "./fullscreenMotion";
import { applyReadingFullscreen } from "./readingFullscreen";

/**
 * Reading full screen, kept outside React state on purpose.
 *
 * It is a visual mode of the app root, not data any view renders from. Held in
 * the shell context it re-rendered every open tab's workspace on each toggle
 * (one Board per tab), which cost long frames on the tablet. Here the root gets
 * a `data-fullscreen` attribute (React never writes it, so a re-render cannot
 * drop it), the motion and the native bars run, and only the button that shows
 * the state subscribes.
 */
let on = false;
let root: HTMLElement | null = null;
const listeners = new Set<() => void>();

const onKey = (event: KeyboardEvent) => {
  if (event.key === "Escape") setReadingFullscreen(false);
};

/** The app root (`.lc-app`). Its direct children are what the motion moves. */
export function registerFullscreenRoot(element: HTMLElement | null): void {
  root = element;
}

export function isReadingFullscreen(): boolean {
  return on;
}

export function subscribeReadingFullscreen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setReadingFullscreen(next: boolean): void {
  if (next === on) return;
  on = next;
  if (root) {
    if (on) root.dataset.fullscreen = "true";
    else delete root.dataset.fullscreen;
    void animateFullscreenChange(root, on);
  }
  void applyReadingFullscreen(on).catch(() => {});
  if (typeof window !== "undefined") {
    if (on) window.addEventListener("keydown", onKey);
    else window.removeEventListener("keydown", onKey);
  }
  for (const listener of listeners) listener();
}

export function toggleReadingFullscreen(): void {
  setReadingFullscreen(!on);
}

export function useReadingFullscreenOn(): boolean {
  return useSyncExternalStore(subscribeReadingFullscreen, isReadingFullscreen, () => false);
}
