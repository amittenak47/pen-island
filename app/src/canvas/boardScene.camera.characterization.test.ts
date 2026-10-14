import { describe, expect, it } from "vitest";
import { createBoardScene } from "./boardScene";

// The typed read must only unwrap zoom. Existing callers keep their fallbacks.
const readCamera = (api: ReturnType<typeof createBoardScene>) => {
  const state = api.getAppState();
  return {
    scrollX: state.scrollX,
    scrollY: state.scrollY,
    zoom: (state.zoom as { value?: number } | undefined)?.value,
    width: state.width,
    height: state.height,
    offsetLeft: state.offsetLeft,
    offsetTop: state.offsetTop,
  };
};

describe("camera reads before the typed facade", () => {
  it.each([
    [{}, { scrollX: 0, scrollY: 0, zoom: 1, width: 1, height: 1, offsetLeft: 0, offsetTop: 0 }],
    [{ scrollX: -12.5, scrollY: 40.25, zoom: { value: 1.5 }, width: 800, height: 600, offsetLeft: 12, offsetTop: 24 },
      { scrollX: -12.5, scrollY: 40.25, zoom: 1.5, width: 800, height: 600, offsetLeft: 12, offsetTop: 24 }],
    [{ scrollX: -0, scrollY: -0, zoom: { value: 0 } },
      { scrollX: -0, scrollY: -0, zoom: 0, width: 1, height: 1, offsetLeft: 0, offsetTop: 0 }],
    [{ scrollX: undefined, scrollY: undefined, zoom: undefined, width: undefined, height: undefined, offsetLeft: undefined, offsetTop: undefined },
      { scrollX: undefined, scrollY: undefined, zoom: undefined, width: undefined, height: undefined, offsetLeft: undefined, offsetTop: undefined }],
    [{ zoom: 1.5, width: 0, height: 0 },
      { scrollX: 0, scrollY: 0, zoom: undefined, width: 0, height: 0, offsetLeft: 0, offsetTop: 0 }],
    [{ zoom: { value: NaN }, scrollX: Infinity, scrollY: -Infinity },
      { scrollX: Infinity, scrollY: -Infinity, zoom: NaN, width: 1, height: 1, offsetLeft: 0, offsetTop: 0 }],
    [{ zoom: { value: 2, extra: "retained in appState" }, selectedElementIds: { a: true } },
      { scrollX: 0, scrollY: 0, zoom: 2, width: 1, height: 1, offsetLeft: 0, offsetTop: 0 }],
  ])("keeps the raw fields for row %#", (appState, expected) => {
    const api = createBoardScene({ appState });
    expect(readCamera(api)).toEqual(expected);
    api.updateScene({ appState });
    expect(readCamera(api)).toEqual(expected);
  });
});
