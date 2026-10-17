/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ts from "typescript";
import cameraSource from "./cameraController.ts?raw";
import boardSource from "./Board.tsx?raw";
import { CaptureUpdateAction, createBoardScene } from "./boardScene";
import { INK_OVERDRAW_FRACTION, OVERDRAW_REBASE_HEADROOM, panDelta } from "./panOffset";
import {
  CAMERA_IDLE_TEARDOWN_MS, cameraPulseSettleMs, isCameraBusy,
  noteCameraBusy, noteCameraIdlePulse, resetCameraBusyForTests,
} from "../util/cameraBusy";
import {
  isDocCameraLive, makeDocFlagHolds, resetDocCameraForTests, subscribeDocCameraPulse,
} from "./docSelectionGesture";

// Board's document/ink mount is wider than this camera contract. Compile its
// actual closures, without mounting React or copying their implementations.
// These are the sites in d06e4e6d Board.tsx that the harness executes:
// setPagePanOffset 2364-2384; clearPanOffsets 2390-2393;
// settleCameraPulse 2403-2413; pulseCameraMotion 2417-2464;
// landPanOffset 3385-3403; applyVisualScrollNow 4245-4366;
// flushVisualScroll 4368-4376; scheduleVisualScroll 4378-4390;
// rebaseVisualScroll 4401-4436; commitVisualScroll 4445-4486.
// The first source supplies moved closures; Board supplies any retained adapters.
const names = [
  "setPagePanOffset", "clearPanOffsets", "settleCameraPulse", "pulseCameraMotion",
  "landPanOffset", "applyVisualScrollNow", "flushVisualScroll",
  "scheduleVisualScroll", "rebaseVisualScroll", "commitVisualScroll",
] as const;
type Driver = Record<typeof names[number], (...args: number[]) => void>;

function callbacks(source: string): Map<string, string> {
  const file = ts.createSourceFile("camera.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let init = node.initializer;
      if (ts.isCallExpression(init) && init.expression.getText(file) === "useCallback") init = init.arguments[0];
      if (ts.isArrowFunction(init)) found.set(node.name.text, init.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function bindCamera(environment: Record<string, unknown>): Driver {
  const moved = callbacks(cameraSource), board = callbacks(boardSource);
  const declarations = names.map(name => {
    const callback = moved.get(name) ?? board.get(name);
    expect(callback, name).toBeDefined();
    return `const ${name} = observe(${JSON.stringify(name)}, ${callback});`;
  });
  const code = ts.transpileModule(`${declarations.join("\n")}\nreturn {${names.join(",")}};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as Driver;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  resetCameraBusyForTests();
  resetDocCameraForTests();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetCameraBusyForTests();
  resetDocCameraForTests();
});

it("keeps sample, coalesced ride, in-flight rebase, pulse settle and idle commit ordered", async () => {
  const log: string[] = [];
  const record = (event: string, value?: unknown) =>
    log.push(`${Date.now()} ${event}${value === undefined ? "" : ` ${JSON.stringify(value)}`}`);
  const cell = <T,>(current: T) => ({ current });
  const scene = createBoardScene({ appState: {
    scrollX: 0, scrollY: 0, zoom: { value: 1 }, width: 1000, height: 800, offsetLeft: 12, offsetTop: 24,
  } });
  const updateScene = scene.updateScene.bind(scene);
  const setCamera = scene.setCamera.bind(scene);
  vi.spyOn(scene, "updateScene").mockImplementation(update => {
    record("updateScene", update);
    updateScene(update);
  });
  vi.spyOn(scene, "setCamera").mockImplementation(camera => {
    record("setCamera", camera);
    setCamera(camera);
  });
  const liveCameraRef = cell<null | {
    scrollX: number; scrollY: number; zoom: number; width: number; height: number;
    offsetLeft: number; offsetTop: number; live: boolean;
  }>(null);
  const committedPanCameraRef = cell({ scrollX: 0, scrollY: 0, zoom: 1 });
  const panOffsetRef = cell({ x: 0, y: 0 });
  const pendingVisualScrollRef = cell<{ scrollX: number; scrollY: number } | null>(null);
  const committingScrollRef = cell(false);
  const holds = makeDocFlagHolds("characterization");
  const unsubscribe = subscribeDocCameraPulse(live => record("setDocCameraLive", live));
  const docFlags = {
    camera: (live: boolean) => { record("docFlags.camera", live); holds.camera(live); },
    pointer: holds.pointer,
  };
  let present: (() => void) | undefined;
  let inkPainted = { scrollX: 0, scrollY: 0, zoom: 1 };
  const ink = {
    setPanOffset: (camera: typeof inkPainted | null) => {
      record("ink.setPanOffset", camera);
      return camera == null || !panDelta(camera, inkPainted, { width: 1000, height: 800 }, undefined, {
        y: 800 * INK_OVERDRAW_FRACTION * OVERDRAW_REBASE_HEADROOM,
      }).rebase;
    },
    syncCamera: () => {
      const camera = scene.getCamera();
      const painted = { scrollX: camera.scrollX, scrollY: camera.scrollY, zoom: camera.zoom };
      record("ink.syncCamera", painted);
      return new Promise<void>(resolve => { present = () => { inkPainted = painted; resolve(); }; });
    },
    setCameraMoving: (moving: boolean) => record("ink.setCameraMoving", moving),
    isDrawing: () => false,
  };
  const overlay = document.createElement("div");
  const lined = document.createElement("div");
  const environment = {
    observe: (name: string, callback: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      if (name === "clearPanOffsets" || name === "setPagePanOffset") record(name, args);
      return callback(...args);
    },
    CaptureUpdateAction, panDelta, INK_OVERDRAW_FRACTION, OVERDRAW_REBASE_HEADROOM,
    CAMERA_IDLE_TEARDOWN_MS, cameraPulseSettleMs, isDocCameraLive,
    noteCameraBusy: () => { record("noteCameraBusy"); noteCameraBusy(); },
    noteCameraIdlePulse: () => { record("noteCameraIdlePulse"); noteCameraIdlePulse(); },
    apiRef: cell(scene), liveCameraRef, committedPanCameraRef, panOffsetRef, pendingVisualScrollRef,
    committingScrollRef, visualScrollRafRef: cell(0), slotReportFrameRef: cell(0),
    cameraMotionTimerRef: cell(0), cameraIdleTeardownTimerRef: cell(0),
    cameraMotionActiveRef: cell(false), panRidePrimedRef: cell(false), cameraLiveClassRafRef: cell(0),
    readingZoomRef: cell(null), splitPausedRef: cell(false), handPanningRef: cell(false), inertiaFrameRef: cell(0),
    scrollModeRef: cell(false), lockedScrollXRef: cell(null), pendingPdfPageRef: cell(0),
    pageBoundsRef: cell(null), pageContentRef: cell(true), stampTrashPosRef: cell(null),
    filmScope: "characterization", docFlags, rasterInkRef: cell(ink),
    ensurePanRideNodes: () => [overlay], refreshPanRideNodes: () => record("refreshPanRideNodes"),
    linedSlotNodeRef: cell(lined), lastLinedSlotRef: cell({ phase: 3 }),
    setPanRideWillChange: (on: boolean) => record("setPanRideWillChange", on),
    placeContentSlotAtRef: cell((x: number, y: number, z: number) => record("placeContentSlotAt", [x, y, z])),
    publishPdfFilmFromScrollRef: cell(() => {}),
    sceneOverlayRef: cell({ redraw: () => record("scene.redraw") }),
    shapeSelectRef: cell({ redraw: () => record("selection.redraw") }),
    runSlotReports: () => record("runSlotReports"),
    setPagePanOffsetRef: cell<(x: number, y: number) => void>(() => {}),
    clearPanOffsetsRef: cell<() => void>(() => {}),
    settleCameraPulseRef: cell<() => void>(() => {}),
    pulseCameraMotionRef: cell<() => void>(() => {}),
    rebaseVisualScrollRef: cell<() => void>(() => {}),
    commitVisualScrollRef: cell<() => void>(() => {}),
  };
  const driver = bindCamera(environment);
  // Mirrors Board's render-time callback-ref assignments, not an effect.
  for (const name of ["setPagePanOffset", "clearPanOffsets", "settleCameraPulse", "pulseCameraMotion",
    "rebaseVisualScroll", "commitVisualScroll"] as const) {
    environment[`${name}Ref`].current = driver[name];
  }
  const finishPresent = async () => { expect(present).toBeDefined(); present!(); present = undefined; await Promise.resolve(); };

  try {
    record("sample");
    driver.applyVisualScrollNow(0, -80);
    vi.advanceTimersByTime(16);
    record("ride");
    driver.scheduleVisualScroll(0, -160);
    driver.scheduleVisualScroll(0, -220);
    vi.advanceTimersByTime(16);
    driver.scheduleVisualScroll(0, -300);
    vi.advanceTimersByTime(16);
    expect(scene.getCamera().scrollY).toBe(0);
    expect(overlay.style.transform).toBe("translate3d(0px, -300px, 0)");
    expect(lined.style.backgroundPosition).toBe("0px -297px");

    record("rebase");
    driver.applyVisualScrollNow(0, -600);
    // Another sample while the ink present is pending must keep riding and
    // must not start a second rebase (Board.tsx:4356-4362).
    driver.applyVisualScrollNow(0, -620);
    expect(scene.updateScene).toHaveBeenCalledTimes(1);
    expect(committedPanCameraRef.current.scrollY).toBe(0);
    await finishPresent();
    expect(committedPanCameraRef.current.scrollY).toBe(-620);
    vi.advanceTimersByTime(16);

    record("settle");
    vi.advanceTimersByTime(cameraPulseSettleMs() - 17);
    expect(isDocCameraLive("characterization")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isDocCameraLive("characterization")).toBe(false);
    expect(liveCameraRef.current?.live).toBe(true);
    expect(scene.updateScene).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CAMERA_IDLE_TEARDOWN_MS - cameraPulseSettleMs() - 1);
    expect(scene.updateScene).toHaveBeenCalledTimes(1);
    record("commit");
    vi.advanceTimersByTime(1);
    expect(liveCameraRef.current?.live).toBe(false);
    expect(committingScrollRef.current).toBe(true);
    await finishPresent();
    vi.advanceTimersByTime(16);
    expect(committingScrollRef.current).toBe(false);
    expect(panOffsetRef.current).toEqual({ x: 0, y: 0 });
    expect(overlay.style.transform).toBe("");
    expect(isCameraBusy()).toBe(false);
    expect(scene.getCamera().scrollY).toBe(-620);
    expect(scene.setCamera).not.toHaveBeenCalled();
    expect(log).toMatchInlineSnapshot(`
      [
        "0 sample",
        "0 placeContentSlotAt [0,-80,1]",
        "0 ink.setPanOffset {"scrollX":0,"scrollY":-80,"zoom":1}",
        "0 setPagePanOffset [0,-80]",
        "0 noteCameraBusy",
        "0 noteCameraIdlePulse",
        "0 refreshPanRideNodes",
        "0 ink.setCameraMoving true",
        "16 docFlags.camera true",
        "16 setDocCameraLive true",
        "16 setPanRideWillChange true",
        "16 ride",
        "32 placeContentSlotAt [0,-220,1]",
        "32 ink.setPanOffset {"scrollX":0,"scrollY":-220,"zoom":1}",
        "32 setPagePanOffset [0,-220]",
        "32 noteCameraBusy",
        "32 noteCameraIdlePulse",
        "48 placeContentSlotAt [0,-300,1]",
        "48 ink.setPanOffset {"scrollX":0,"scrollY":-300,"zoom":1}",
        "48 setPagePanOffset [0,-300]",
        "48 noteCameraBusy",
        "48 noteCameraIdlePulse",
        "48 rebase",
        "48 placeContentSlotAt [0,-600,1]",
        "48 ink.setPanOffset {"scrollX":0,"scrollY":-600,"zoom":1}",
        "48 updateScene {"appState":{"scrollX":0,"scrollY":-600},"captureUpdate":"NEVER"}",
        "48 ink.syncCamera {"scrollX":0,"scrollY":-600,"zoom":1}",
        "48 setPagePanOffset [0,-600]",
        "48 noteCameraBusy",
        "48 noteCameraIdlePulse",
        "48 placeContentSlotAt [0,-620,1]",
        "48 ink.setPanOffset {"scrollX":0,"scrollY":-620,"zoom":1}",
        "48 setPagePanOffset [0,-620]",
        "48 noteCameraBusy",
        "48 noteCameraIdlePulse",
        "48 clearPanOffsets []",
        "48 setPagePanOffset [0,0]",
        "48 ink.setPanOffset null",
        "48 scene.redraw",
        "48 selection.redraw",
        "64 placeContentSlotAt [0,-620,1]",
        "64 clearPanOffsets []",
        "64 setPagePanOffset [0,0]",
        "64 ink.setPanOffset null",
        "64 scene.redraw",
        "64 selection.redraw",
        "64 runSlotReports",
        "64 settle",
        "188 docFlags.camera false",
        "188 setDocCameraLive false",
        "188 setPanRideWillChange false",
        "15047 commit",
        "15048 updateScene {"appState":{"scrollX":0,"scrollY":-620},"captureUpdate":"NEVER"}",
        "15048 ink.syncCamera {"scrollX":0,"scrollY":-620,"zoom":1}",
        "15048 ink.setCameraMoving false",
        "15048 clearPanOffsets []",
        "15048 setPagePanOffset [0,0]",
        "15048 ink.setPanOffset null",
        "15048 scene.redraw",
        "15048 selection.redraw",
        "15064 clearPanOffsets []",
        "15064 setPagePanOffset [0,0]",
        "15064 ink.setPanOffset null",
        "15064 scene.redraw",
        "15064 selection.redraw",
        "15064 runSlotReports",
      ]
    `);
  } finally {
    unsubscribe();
    holds.camera(false);
    holds.pointer(false);
  }
});
