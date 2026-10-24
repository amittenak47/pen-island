/**
 * A picture of part of the app's window, as the screen shows it.
 *
 * For what the board's own export cannot picture: a local page running live
 * is a sandboxed frame in a process of its own, and a copy of the app's DOM
 * holds nothing of it. WebView2 photographs its own surface on Windows;
 * PixelCopy reads the window on Android (`capture_app_region`).
 *
 * The selection's own chrome is hidden while the picture is taken
 * (`.lc-screen-capturing` in styles.css), so the band and the menu over the
 * words are not in it. The ink is: it is on the page.
 */

/** Viewport rectangle in CSS px, as `getBoundingClientRect` gives it. */
export interface ScreenRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const SCREEN_CAPTURING_CLASS = "lc-screen-capturing";

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

export async function captureScreenRegion(region: ScreenRegion): Promise<Blob> {
  const left = Math.max(0, region.left);
  const top = Math.max(0, region.top);
  const right = Math.min(window.innerWidth, region.left + region.width);
  const bottom = Math.min(window.innerHeight, region.top + region.height);
  if (!(right - left >= 1 && bottom - top >= 1)) throw new Error("The selection is off the screen. Scroll it into view.");
  const { invoke } = await import("@tauri-apps/api/core");
  const root = document.documentElement;
  root.classList.add(SCREEN_CAPTURING_CLASS);
  try {
    await nextPaint();
    const png = await invoke<ArrayBuffer>("capture_app_region", {
      region: { x: left, y: top, width: right - left, height: bottom - top },
      density: window.devicePixelRatio || 1,
    });
    if (!(png instanceof ArrayBuffer) || png.byteLength === 0) throw new Error("The screen capture came back empty.");
    return new Blob([png], { type: "image/png" });
  } finally {
    root.classList.remove(SCREEN_CAPTURING_CLASS);
  }
}
