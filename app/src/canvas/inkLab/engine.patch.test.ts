import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import { createInkLabEngine, SNAP_PATCH_MIN_PX } from "./engine";

const alphaAt = (canvas: HTMLCanvasElement, x: number, y: number) =>
  canvas.getContext("2d")!.getImageData(x, y, 1, 1).data[3]!;

describe("snap undo patches", () => {
  it("keeps a letter's patch canvas big enough for the GPU, and restores only the patch", () => {
    const canvas = createCanvas(600, 400) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.down({ x: 40, y: 40, p: 0.5, t: 0 });
    engine.move([{ x: 52, y: 44, p: 0.5, t: 8 }, { x: 60, y: 40, p: 0.5, t: 16 }]);
    engine.paint();
    const { undoPatch } = engine.liftRaw({ x: 64, y: 42, p: 0.5, t: 24 });
    const patch = undoPatch!;
    expect(patch.w).toBeLessThan(SNAP_PATCH_MIN_PX);
    const image = patch.image as HTMLCanvasElement;
    expect(image.width).toBeGreaterThanOrEqual(SNAP_PATCH_MIN_PX);
    expect(image.height).toBeGreaterThanOrEqual(SNAP_PATCH_MIN_PX);

    // Ink just right of the patch, inside the padded canvas's reach.
    const nx = patch.x + patch.w + 10;
    engine.paintOntoSnap((ctx) => {
      ctx.fillStyle = "#000";
      ctx.fillRect(nx, patch.y, 20, 20);
    });
    engine.restoreSnapPatch(patch);
    engine.paint();
    expect(alphaAt(canvas, nx + 5, patch.y + 5)).toBe(255);
    // The stroke under the patch is undone.
    expect(alphaAt(canvas, 52, 44)).toBe(0);
    engine.destroy();
  });
});
