import { describe, expect, it } from "vitest";
import { contentSlotPlaceAt } from "./contentSlotPlace";
import { scenePointFromCanvasPixel } from "./rasterInk";

type Camera = { scrollX: number; scrollY: number; zoom: number };

// Before the move, these are the proposed helpers. Only this adapter changes.
const sceneToScreen = (cam: Camera, x: number, y: number) => ({
  x: (x + cam.scrollX) * cam.zoom,
  y: (y + cam.scrollY) * cam.zoom,
});
const screenToScene = (cam: Camera, x: number, y: number) => ({
  x: x / cam.zoom - cam.scrollX,
  y: y / cam.zoom - cam.scrollY,
});

// Formula copies keep the starting revision's operation order and site names.
const Board_2841 = (scrollX: number, scrollY: number, zoom: number, column: { minX: number }, box: { minY: number }) => ({
  x: (column.minX + scrollX) * zoom,
  y: (box.minY + scrollY) * zoom,
});
const Board_3206 = (scrollY: number, zoom: number, firstRuleScene: number) =>
  (firstRuleScene + scrollY) * zoom;
const contentSlotPlace_61 = (scrollX: number, scrollY: number, zoom: number, bounds: { minX: number; minY: number }) => ({
  x: (bounds.minX + scrollX) * zoom,
  y: (bounds.minY + scrollY) * zoom,
});
const rasterInk_6005 = (localX: number, localY: number, zoom: number, scrollX: number, scrollY: number) => ({
  x: localX / zoom - scrollX,
  y: localY / zoom - scrollY,
});

function samples(): Array<{ cam: Camera; x: number; y: number }> {
  let seed = 0x2ca6e4;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const rows = [
    { cam: { scrollX: 0, scrollY: 0, zoom: 1 }, x: 0, y: 0 },
    { cam: { scrollX: -0, scrollY: -0, zoom: 1 }, x: -0, y: -0 },
    { cam: { scrollX: -0.25, scrollY: 0.125, zoom: 1 }, x: 0.125, y: -0.375 },
    { cam: { scrollX: 100000, scrollY: -100000, zoom: 0.1 }, x: 1 / 3, y: -1 / 7 },
    { cam: { scrollX: -100000, scrollY: 100000, zoom: 8 }, x: -0.75, y: 0.625 },
  ];
  for (let i = 0; i < 256; i += 1) rows.push({
    cam: { scrollX: random() * 2e5 - 1e5, scrollY: random() * 2e5 - 1e5, zoom: 0.1 + random() * 7.9 },
    x: random() * 2e5 - 1e5,
    y: random() * 2e5 - 1e5,
  });
  return rows;
}

describe("camera formulas before the move", () => {
  it("Board.tsx:2841 page mask", () => {
    for (const { cam, x, y } of samples()) {
      expect(sceneToScreen(cam, x, y)).toEqual(Board_2841(cam.scrollX, cam.scrollY, cam.zoom, { minX: x }, { minY: y }));
    }
  });

  it("Board.tsx:3206 first lined rule", () => {
    for (const { cam, y } of samples()) {
      expect(sceneToScreen(cam, 0, y).y).toBe(Board_3206(cam.scrollY, cam.zoom, y));
    }
  });

  it("contentSlotPlace.ts:61-62 bounded placement", () => {
    for (const { cam, x, y } of samples()) {
      const bounds = { minX: x, minY: y, maxX: x + 100, maxY: y + 200 };
      const copied = contentSlotPlace_61(cam.scrollX, cam.scrollY, cam.zoom, bounds);
      const placed = contentSlotPlaceAt(cam.scrollX, cam.scrollY, cam.zoom, bounds, null)!;
      expect(sceneToScreen(cam, x, y)).toEqual(copied);
      expect({ x: placed.left, y: placed.top }).toEqual(copied);
    }
  });

  it("rasterInk.ts:6005-6006 canvas pixel", () => {
    for (const { cam, x, y } of samples()) {
      const copied = rasterInk_6005(x, y, cam.zoom, cam.scrollX, cam.scrollY);
      expect(screenToScene(cam, x, y)).toEqual(copied);
      expect(scenePointFromCanvasPixel(x, y, cam)).toEqual(copied);
    }
  });
});
