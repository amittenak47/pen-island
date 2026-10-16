import { describe, expect, it } from "vitest";
import { CaptureUpdateAction, createBoardScene } from "./boardScene";

describe("scene camera", () => {
  it("returns the store defaults after construction", () => {
    expect(createBoardScene().getCamera()).toEqual({
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      width: 1,
      height: 1,
      offsetLeft: 0,
      offsetTop: 0,
    });
  });

  it("reads camera and viewport fields after typed and legacy writes", () => {
    const viewport = { width: 800, height: 600, offsetLeft: 12, offsetTop: 24 };
    const api = createBoardScene({
      appState: { ...viewport, scrollX: 3, scrollY: -4, zoom: { value: 1.25 } },
    });
    expect(api.getCamera()).toEqual({ ...viewport, scrollX: 3, scrollY: -4, zoom: 1.25 });

    api.setCamera({ scrollX: 10, scrollY: -30 });
    expect(api.getCamera()).toEqual({ ...viewport, scrollX: 10, scrollY: -30, zoom: 1.25 });

    api.setCamera({ zoom: 1.5 });
    expect(api.getCamera()).toEqual({ ...viewport, scrollX: 10, scrollY: -30, zoom: 1.5 });

    api.setCamera({ scrollX: -12.5, scrollY: 40.25, zoom: 2 });
    expect(api.getCamera()).toEqual({ ...viewport, scrollX: -12.5, scrollY: 40.25, zoom: 2 });

    api.updateScene({
      appState: { scrollX: -100, scrollY: -200, zoom: { value: 1.75 } },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    expect(api.getCamera()).toEqual({ ...viewport, scrollX: -100, scrollY: -200, zoom: 1.75 });
  });

  it("uses existing defaults when numeric fields are missing", () => {
    const api = createBoardScene({
      appState: {
        scrollX: undefined,
        scrollY: undefined,
        zoom: undefined,
        width: undefined,
        height: undefined,
        offsetLeft: undefined,
        offsetTop: undefined,
      },
    });
    expect(api.getCamera()).toEqual({
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      width: 1,
      height: 1,
      offsetLeft: 0,
      offsetTop: 0,
    });
  });
});
