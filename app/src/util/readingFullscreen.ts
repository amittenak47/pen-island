import { isAndroidDevice } from "./androidDevice";
import { setReadingFullscreenNative } from "./gestureExclusion";

/**
 * Real full screen for reading: the window on desktop, the status and
 * navigation bars on the tablet. Quiet in a plain browser build.
 */
export async function applyReadingFullscreen(on: boolean): Promise<void> {
  if (isAndroidDevice()) {
    await setReadingFullscreenNative(on);
    return;
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(on);
  } catch {
    /* not inside Tauri: the header still hides */
  }
}
