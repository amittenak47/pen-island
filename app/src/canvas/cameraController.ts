import type { Camera, Viewport } from "./camera";
import type { DocFlagHolds } from "./docSelectionGesture";
import type { RasterInkHandle } from "./WhiteboardInkLab";

type Cell<T> = { current: T };
export type LiveCamera = Camera & Viewport & { live: boolean };

type CameraControllerBindings = {
  ensurePanRideNodes(): HTMLElement[];
  rasterInkRef: Cell<Pick<RasterInkHandle, "setPanOffset"> | null>;
  linedSlotNodeRef: Cell<HTMLDivElement | null>;
  lastLinedSlotRef: Cell<{ phase: number } | null>;
  readingZoomRef: Cell<unknown>;
  docFlags: DocFlagHolds;
  setPanRideWillChange(on: boolean): void;
  applyVisualScrollNow(scrollX: number, scrollY: number): void;
};

const cell = <T,>(current: T): Cell<T> => ({ current });

/** Created once per Board; bindings are supplied in render before effects run. */
export function createCameraController() {
  /** True while commitVisualScroll's updateScene is in flight — skip re-clamp. */
  const committingScrollRef = cell(false);
  /**
   * Live camera while reading-scroll is in flight.
   *
   * The scene store keeps the painted camera while this ref drives the live
   * camera during pans (the translate ride). Commit the live camera to the
   * store when the pan settles.
   */
  const liveCameraRef = cell<LiveCamera | null>(null);
  /**
   * Scene-store camera the layers were last painted for during a live gesture.
   * Updated on the first live sample and after each mid-gesture rebase — so
   * `applyVisualScrollNow` can skip `getAppState` on every coalesced frame.
   */
  const committedPanCameraRef = cell({ scrollX: 0, scrollY: 0, zoom: 1 });
  const pendingVisualScrollRef = cell<{ scrollX: number; scrollY: number } | null>(null);
  const visualScrollRafRef = cell(0);
  /**
   * Wheel / scroll bursts must pin ink tiles the same way a pan does.
   * Without this, every scroll frame paid full raster budget (camera perf).
   */
  const cameraMotionTimerRef = cell(0);
  const cameraIdleTeardownTimerRef = cell(0);
  const cameraMotionActiveRef = cell(false);
  const panRidePrimedRef = cell(false);
  const cameraLiveClassRafRef = cell(0);
  /**
   * How far the page has been dragged from the camera everything was painted at.
   *
   * Reading scroll leaves the scene store's painted camera alone until settle
   * (see `applyVisualScrollNow`), so the ink bitmap, the scene overlay, the
   * selection chrome, the lined paper and the page title are all still correct
   * *relative to the page* and wrong only by this translation. Writing
   * `translate3d` on those few nodes (not a custom property on the board root)
   * keeps the compositor cheap — `--lc-pan-*` on `.lc-board` invalidated style
   * for the whole markdown subtree every sample.
   */
  const panOffsetRef = cell({ x: 0, y: 0 });

  let ensurePanRideNodes: CameraControllerBindings["ensurePanRideNodes"];
  let rasterInkRef: CameraControllerBindings["rasterInkRef"];
  let linedSlotNodeRef: CameraControllerBindings["linedSlotNodeRef"];
  let lastLinedSlotRef: CameraControllerBindings["lastLinedSlotRef"];
  let readingZoomRef: CameraControllerBindings["readingZoomRef"];
  let docFlags: CameraControllerBindings["docFlags"];
  let setPanRideWillChange: CameraControllerBindings["setPanRideWillChange"];
  let applyVisualScrollNow: CameraControllerBindings["applyVisualScrollNow"];

  const bind = (next: CameraControllerBindings) => {
    ({ ensurePanRideNodes, rasterInkRef, linedSlotNodeRef, lastLinedSlotRef,
      readingZoomRef, docFlags, setPanRideWillChange, applyVisualScrollNow } = next);
  };

  const setPagePanOffset = (dx: number, dy: number) => {
    const current = panOffsetRef.current;
    if (current.x === dx && current.y === dy) return;
    panOffsetRef.current = { x: dx, y: dy };
    const next =
      dx === 0 && dy === 0 ? "" : `translate3d(${dx}px, ${dy}px, 0)`;
    for (const node of ensurePanRideNodes()) {
      // Ink owns its painted camera, which can advance during an async
      // rebase before the other overlays land. Never overwrite its delta.
      if (node.classList.contains("lc-ink-lab-canvas")) continue;
      if (node.style.transform !== next) node.style.transform = next;
    }
    const lined = linedSlotNodeRef.current;
    const slot = lastLinedSlotRef.current;
    if (lined && slot) {
      lined.style.backgroundPosition = `0 ${slot.phase + dy}px`;
    }
  };

  /** Put every layer back on its painted coordinates. */
  const clearPanOffsets = () => {
    setPagePanOffset(0, 0);
    rasterInkRef.current?.setPanOffset(null);
  };
  /**
   * The camera has stopped: drop this board's share of the paint freeze.
   *
   * Run by the pulse's settle timer, or early when a finger holding the page
   * has rested (see `FINGER_REST_MS`).
   */
  const settleCameraPulse = () => {
    if (cameraMotionTimerRef.current) window.clearTimeout(cameraMotionTimerRef.current);
    cameraMotionTimerRef.current = 0;
    cameraMotionActiveRef.current = false;
    if (cameraLiveClassRafRef.current) {
      cancelAnimationFrame(cameraLiveClassRafRef.current);
      cameraLiveClassRafRef.current = 0;
    }
    if (!readingZoomRef.current) docFlags.camera(false);
    setPanRideWillChange(false);
  };
  const flushVisualScroll = () => {
    if (visualScrollRafRef.current) {
      cancelAnimationFrame(visualScrollRafRef.current);
      visualScrollRafRef.current = 0;
    }
    const pending = pendingVisualScrollRef.current;
    pendingVisualScrollRef.current = null;
    if (pending) applyVisualScrollNow(pending.scrollX, pending.scrollY);
  };

  const scheduleVisualScroll = (scrollX: number, scrollY: number) => {
    pendingVisualScrollRef.current = { scrollX, scrollY };
    if (visualScrollRafRef.current) return;
    visualScrollRafRef.current = requestAnimationFrame(() => {
      visualScrollRafRef.current = 0;
      const pending = pendingVisualScrollRef.current;
      pendingVisualScrollRef.current = null;
      if (pending) applyVisualScrollNow(pending.scrollX, pending.scrollY);
    });
  };

  const releaseCamera = () => {
    if (cameraMotionTimerRef.current) window.clearTimeout(cameraMotionTimerRef.current);
    cameraMotionTimerRef.current = 0;
    if (cameraIdleTeardownTimerRef.current) window.clearTimeout(cameraIdleTeardownTimerRef.current);
    cameraIdleTeardownTimerRef.current = 0;
    if (cameraLiveClassRafRef.current) cancelAnimationFrame(cameraLiveClassRafRef.current);
    cameraLiveClassRafRef.current = 0;
    if (visualScrollRafRef.current) cancelAnimationFrame(visualScrollRafRef.current);
    visualScrollRafRef.current = 0;
    pendingVisualScrollRef.current = null;
    cameraMotionActiveRef.current = false;
    // A parked/closed document must release its paint hold. Cancelling only
    // the settle timer left the hold latched indefinitely.
    docFlags.camera(false);
    docFlags.pointer(false);
    setPanRideWillChange(false);
  };

  return {
    live: liveCameraRef,
    painted: committedPanCameraRef,
    panOffset: panOffsetRef,
    committing: committingScrollRef,
    pendingVisualScroll: pendingVisualScrollRef,
    visualScrollRaf: visualScrollRafRef,
    motionTimer: cameraMotionTimerRef,
    idleTeardownTimer: cameraIdleTeardownTimerRef,
    motionActive: cameraMotionActiveRef,
    ridePrimed: panRidePrimedRef,
    liveClassRaf: cameraLiveClassRafRef,
    bind,
    setPagePanOffset,
    clearPanOffsets,
    settleCameraPulse,
    flushVisualScroll,
    scheduleVisualScroll,
    releaseCamera,
  };
}

export type CameraController = ReturnType<typeof createCameraController>;
