import { describe, expect, it } from "vitest";
import { CaptureUpdateAction, createBoardScene } from "./boardScene";

type Scene = ReturnType<typeof createBoardScene>;
type CameraPatch = { scrollX?: number; scrollY?: number; zoom?: number };

const updateCamera = (api: Scene, next: CameraPatch) => {
  const { zoom, ...scroll } = next;
  api.updateScene({
    appState: { ...scroll, ...(zoom === undefined ? {} : { zoom: { value: zoom } }) },
    captureUpdate: CaptureUpdateAction.NEVER,
  });
};

// The candidate uses the old path until the typed API exists.
const adapters = {
  updateScene: updateCamera,
  typedCamera: (api: Scene, next: CameraPatch) => api.setCamera(next),
};
const subscribe = (api: Scene, listener: (x: number, y: number, zoom: { value: number }) => void) =>
  api.onScrollChange!(listener);

function record(setCamera: typeof updateCamera, listen = subscribe): unknown[] {
  const api = createBoardScene({
    elements: [{ id: "a", x: 0, y: 0, width: 40, height: 20 }],
    appState: { width: 800, height: 600, offsetLeft: 12, offsetTop: 24 },
  });
  const log: unknown[] = [];
  const camera = () => {
    const state = api.getAppState();
    return [state.scrollX, state.scrollY, state.zoom, state.width, state.height, state.offsetLeft, state.offsetTop];
  };
  listen(api, (x, y, zoom) => log.push(["scroll:first", x, y, { ...zoom }, camera()]));
  const unsubscribe = listen(api, (x, y, zoom) => log.push(["scroll:second", x, y, { ...zoom }, camera()]));
  api.setOnChange!((elements, state) => log.push([
    "change", JSON.parse(JSON.stringify(elements)), camera(), state.selectedElementIds,
  ]));

  setCamera(api, { scrollX: 10, scrollY: -30 });
  setCamera(api, { zoom: 1.5 });
  setCamera(api, { scrollX: -12.5, scrollY: 40.25, zoom: 2 });
  setCamera(api, { scrollY: 40.25 });
  unsubscribe();
  api.updateScene({ elements: [{ id: "b", x: 10, y: 20, width: 60, height: 40 }], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  api.updateScene({ elements: [{ id: "c", x: 20, y: 30, width: 80, height: 60 }], captureUpdate: CaptureUpdateAction.EVENTUALLY });
  api.updateScene({ elements: [{ id: "d", x: 30, y: 40, width: 100, height: 80 }], captureUpdate: CaptureUpdateAction.NEVER });
  api.updateScene({
    elements: [{ id: "e", x: 100, y: 200, width: 40, height: 80 }],
    appState: { scrollX: -100, scrollY: -200, zoom: { value: 1.25 }, selectedElementIds: { e: true } },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  api.scrollToContent();
  log.push(["undo", api.history!.undo()]);
  log.push(["redo", api.history!.redo()]);
  api.history!.clear();
  log.push(["cleared", api.history!.canUndo(), api.history!.canRedo(), api.history!.undo(), api.history!.redo()]);
  return log;
}

describe("scene listener call log before the camera move", () => {
  it("updateScene preserves calls, ordering and history", () => {
    expect(record(adapters.updateScene)).toMatchInlineSnapshot(`
      [
        [
          "scroll:first",
          10,
          -30,
          {
            "value": 1,
          },
          [
            10,
            -30,
            {
              "value": 1,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:second",
          10,
          -30,
          {
            "value": 1,
          },
          [
            10,
            -30,
            {
              "value": 1,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:first",
          10,
          -30,
          {
            "value": 1.5,
          },
          [
            10,
            -30,
            {
              "value": 1.5,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:second",
          10,
          -30,
          {
            "value": 1.5,
          },
          [
            10,
            -30,
            {
              "value": 1.5,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:first",
          -12.5,
          40.25,
          {
            "value": 2,
          },
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:second",
          -12.5,
          40.25,
          {
            "value": 2,
          },
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "change",
          [
            {
              "height": 40,
              "id": "b",
              "width": 60,
              "x": 10,
              "y": 20,
            },
          ],
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "change",
          [
            {
              "height": 60,
              "id": "c",
              "width": 80,
              "x": 20,
              "y": 30,
            },
          ],
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "change",
          [
            {
              "height": 80,
              "id": "d",
              "width": 100,
              "x": 30,
              "y": 40,
            },
          ],
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "scroll:first",
          -100,
          -200,
          {
            "value": 1.25,
          },
          [
            -100,
            -200,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "change",
          [
            {
              "height": 80,
              "id": "e",
              "width": 40,
              "x": 100,
              "y": 200,
            },
          ],
          [
            -100,
            -200,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
          {
            "e": true,
          },
        ],
        [
          "scroll:first",
          200,
          0,
          {
            "value": 1.25,
          },
          [
            200,
            0,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "change",
          [
            {
              "height": 80,
              "id": "d",
              "width": 100,
              "x": 30,
              "y": 40,
            },
          ],
          [
            200,
            0,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "undo",
          true,
        ],
        [
          "change",
          [
            {
              "height": 80,
              "id": "e",
              "width": 40,
              "x": 100,
              "y": 200,
            },
          ],
          [
            200,
            0,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "redo",
          true,
        ],
        [
          "cleared",
          false,
          false,
          false,
          false,
        ],
      ]
    `);
  });
  it("typedCamera preserves calls, ordering and history", () => {
    expect(record(adapters.typedCamera)).toMatchInlineSnapshot(`
      [
        [
          "scroll:first",
          10,
          -30,
          {
            "value": 1,
          },
          [
            10,
            -30,
            {
              "value": 1,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:second",
          10,
          -30,
          {
            "value": 1,
          },
          [
            10,
            -30,
            {
              "value": 1,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:first",
          10,
          -30,
          {
            "value": 1.5,
          },
          [
            10,
            -30,
            {
              "value": 1.5,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:second",
          10,
          -30,
          {
            "value": 1.5,
          },
          [
            10,
            -30,
            {
              "value": 1.5,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:first",
          -12.5,
          40.25,
          {
            "value": 2,
          },
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:second",
          -12.5,
          40.25,
          {
            "value": 2,
          },
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "change",
          [
            {
              "height": 40,
              "id": "b",
              "width": 60,
              "x": 10,
              "y": 20,
            },
          ],
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "change",
          [
            {
              "height": 60,
              "id": "c",
              "width": 80,
              "x": 20,
              "y": 30,
            },
          ],
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "change",
          [
            {
              "height": 80,
              "id": "d",
              "width": 100,
              "x": 30,
              "y": 40,
            },
          ],
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "scroll:first",
          -100,
          -200,
          {
            "value": 1.25,
          },
          [
            -100,
            -200,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "change",
          [
            {
              "height": 80,
              "id": "e",
              "width": 40,
              "x": 100,
              "y": 200,
            },
          ],
          [
            -100,
            -200,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
          {
            "e": true,
          },
        ],
        [
          "scroll:first",
          200,
          0,
          {
            "value": 1.25,
          },
          [
            200,
            0,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "change",
          [
            {
              "height": 80,
              "id": "d",
              "width": 100,
              "x": 30,
              "y": 40,
            },
          ],
          [
            200,
            0,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "undo",
          true,
        ],
        [
          "change",
          [
            {
              "height": 80,
              "id": "e",
              "width": 40,
              "x": 100,
              "y": 200,
            },
          ],
          [
            200,
            0,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "redo",
          true,
        ],
        [
          "cleared",
          false,
          false,
          false,
          false,
        ],
      ]
    `);
  });
  it("camera section preserves calls, ordering and history", () => {
    expect(record(
      (api, next) => api.camera.set(next),
      (api, listener) => api.camera.subscribe(listener),
    )).toMatchInlineSnapshot(`
      [
        [
          "scroll:first",
          10,
          -30,
          {
            "value": 1,
          },
          [
            10,
            -30,
            {
              "value": 1,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:second",
          10,
          -30,
          {
            "value": 1,
          },
          [
            10,
            -30,
            {
              "value": 1,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:first",
          10,
          -30,
          {
            "value": 1.5,
          },
          [
            10,
            -30,
            {
              "value": 1.5,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:second",
          10,
          -30,
          {
            "value": 1.5,
          },
          [
            10,
            -30,
            {
              "value": 1.5,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:first",
          -12.5,
          40.25,
          {
            "value": 2,
          },
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "scroll:second",
          -12.5,
          40.25,
          {
            "value": 2,
          },
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "change",
          [
            {
              "height": 40,
              "id": "b",
              "width": 60,
              "x": 10,
              "y": 20,
            },
          ],
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "change",
          [
            {
              "height": 60,
              "id": "c",
              "width": 80,
              "x": 20,
              "y": 30,
            },
          ],
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "change",
          [
            {
              "height": 80,
              "id": "d",
              "width": 100,
              "x": 30,
              "y": 40,
            },
          ],
          [
            -12.5,
            40.25,
            {
              "value": 2,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "scroll:first",
          -100,
          -200,
          {
            "value": 1.25,
          },
          [
            -100,
            -200,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "change",
          [
            {
              "height": 80,
              "id": "e",
              "width": 40,
              "x": 100,
              "y": 200,
            },
          ],
          [
            -100,
            -200,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
          {
            "e": true,
          },
        ],
        [
          "scroll:first",
          200,
          0,
          {
            "value": 1.25,
          },
          [
            200,
            0,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
        ],
        [
          "change",
          [
            {
              "height": 80,
              "id": "d",
              "width": 100,
              "x": 30,
              "y": 40,
            },
          ],
          [
            200,
            0,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "undo",
          true,
        ],
        [
          "change",
          [
            {
              "height": 80,
              "id": "e",
              "width": 40,
              "x": 100,
              "y": 200,
            },
          ],
          [
            200,
            0,
            {
              "value": 1.25,
            },
            800,
            600,
            12,
            24,
          ],
          {},
        ],
        [
          "redo",
          true,
        ],
        [
          "cleared",
          false,
          false,
          false,
          false,
        ],
      ]
    `);
  });
});
