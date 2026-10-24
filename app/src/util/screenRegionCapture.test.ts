/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { captureScreenRegion, SCREEN_CAPTURING_CLASS } from "./screenRegionCapture";

beforeEach(() => {
  invoke.mockReset();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 1; });
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("devicePixelRatio", 2);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("pictures the on-screen part of the region with the selection's chrome hidden", async () => {
  let capturing = false;
  invoke.mockImplementation(async () => {
    capturing = document.documentElement.classList.contains(SCREEN_CAPTURING_CLASS);
    return new Uint8Array([137, 80, 78, 71]).buffer;
  });
  const blob = await captureScreenRegion({ left: -20, top: 700, width: 220, height: 300 });
  expect(invoke).toHaveBeenCalledWith("capture_app_region", { region: { x: 0, y: 700, width: 200, height: 100 }, density: 2 });
  expect(capturing).toBe(true);
  expect(document.documentElement.classList.contains(SCREEN_CAPTURING_CLASS)).toBe(false);
  expect(blob.type).toBe("image/png");
  expect(blob.size).toBe(4);
});

it("refuses a region off the screen, and shows the chrome again when the capture fails", async () => {
  await expect(captureScreenRegion({ left: 0, top: 900, width: 100, height: 100 })).rejects.toThrow("off the screen");
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockRejectedValue("the screen capture timed out");
  await expect(captureScreenRegion({ left: 0, top: 0, width: 100, height: 100 })).rejects.toBe("the screen capture timed out");
  expect(document.documentElement.classList.contains(SCREEN_CAPTURING_CLASS)).toBe(false);
});
