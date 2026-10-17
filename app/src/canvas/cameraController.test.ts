/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCameraController } from "./cameraController";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function boardCamera() {
  const controller = createCameraController();
  const overlay = document.createElement("div");
  const ink = document.createElement("canvas");
  ink.className = "lc-ink-lab-canvas";
  ink.style.transform = "translate3d(0px, -17px, 0)";
  const lined = document.createElement("div");
  const ports = {
    ensurePanRideNodes: vi.fn(() => [overlay, ink]),
    rasterInkRef: { current: { setPanOffset: vi.fn(() => true) } },
    linedSlotNodeRef: { current: lined },
    lastLinedSlotRef: { current: { phase: 3 } },
    readingZoomRef: { current: null as unknown },
    docFlags: { camera: vi.fn(), pointer: vi.fn() },
    setPanRideWillChange: vi.fn(),
    applyVisualScrollNow: vi.fn(),
  };
  controller.bind(ports);
  return { controller, overlay, ink, lined, ports };
}

it("keeps separate Boards' rides independent and leaves ink's own painted delta alone", () => {
  const a = boardCamera(), b = boardCamera();
  a.controller.setPagePanOffset(4, -80);
  expect(a.controller.panOffset.current).toEqual({ x: 4, y: -80 });
  expect(a.overlay.style.transform).toBe("translate3d(4px, -80px, 0)");
  expect(a.lined.style.backgroundPosition).toBe("0px -77px");
  expect(a.ink.style.transform).toBe("translate3d(0px, -17px, 0)");
  expect(b.overlay.style.transform).toBe("");
  expect(b.controller.panOffset.current).toEqual({ x: 0, y: 0 });
  a.controller.setPagePanOffset(4, -80);
  expect(a.ports.ensurePanRideNodes).toHaveBeenCalledTimes(1);
  a.controller.clearPanOffsets();
  expect(a.overlay.style.transform).toBe("");
  expect(a.ports.rasterInkRef.current.setPanOffset.mock.calls).toEqual([[null]]);
  expect(b.ports.rasterInkRef.current.setPanOffset).not.toHaveBeenCalled();
});

it("coalesces samples into one frame and flushes the last sample before that frame", () => {
  const { controller, ports } = boardCamera();
  controller.scheduleVisualScroll(1, -40);
  controller.scheduleVisualScroll(2, -90);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(16);
  expect(ports.applyVisualScrollNow.mock.calls).toEqual([[2, -90]]);
  controller.scheduleVisualScroll(3, -120);
  controller.flushVisualScroll();
  expect(ports.applyVisualScrollNow.mock.calls).toEqual([[2, -90], [3, -120]]);
  vi.runAllTimers();
  expect(ports.applyVisualScrollNow).toHaveBeenCalledTimes(2);
});

it.each([false, true])("settles the pulse without releasing an active pinch share: %s", zooming => {
  const { controller, ports } = boardCamera();
  const raise = vi.fn();
  controller.liveClassRaf.current = requestAnimationFrame(raise);
  controller.motionTimer.current = window.setTimeout(raise, 140);
  controller.motionActive.current = true;
  ports.readingZoomRef.current = zooming ? {} : null;
  controller.settleCameraPulse();
  vi.runAllTimers();
  expect(raise).not.toHaveBeenCalled();
  expect(controller.motionActive.current).toBe(false);
  if (zooming) expect(ports.docFlags.camera).not.toHaveBeenCalled();
  else expect(ports.docFlags.camera.mock.calls).toEqual([[false]]);
  expect(ports.setPanRideWillChange.mock.calls).toEqual([[false]]);
});

it("releases a parked Board's timers, deferred class raise and pending sample together", () => {
  const { controller, ports } = boardCamera();
  const late = vi.fn();
  controller.motionTimer.current = window.setTimeout(late, 140);
  controller.idleTeardownTimer.current = window.setTimeout(late, 15_000);
  controller.liveClassRaf.current = requestAnimationFrame(late);
  controller.scheduleVisualScroll(0, -80);
  controller.motionActive.current = true;
  controller.releaseCamera();
  vi.runAllTimers();
  expect(late).not.toHaveBeenCalled();
  expect(ports.applyVisualScrollNow).not.toHaveBeenCalled();
  expect(controller.pendingVisualScroll.current).toBeNull();
  expect(controller.motionActive.current).toBe(false);
  expect(ports.docFlags.camera.mock.calls).toEqual([[false]]);
  expect(ports.docFlags.pointer.mock.calls).toEqual([[false]]);
  expect(ports.setPanRideWillChange.mock.calls).toEqual([[false]]);
});
