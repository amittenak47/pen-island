import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpineDot } from "./instance";

/** GL stub: every call is a recorded no-op; constants are numbers. */
function fakeGl(calls: string[], lost = () => false): WebGL2RenderingContext {
  return new Proxy({}, {
    get(_t, key) {
      if (typeof key !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(key)) return 1;
      if (key === "isContextLost") return lost;
      if (key === "getShaderParameter" || key === "getProgramParameter") return () => true;
      if (key === "getExtension") return () => null;
      return () => {
        calls.push(key);
        return {};
      };
    },
  }) as WebGL2RenderingContext;
}

let glCalls: string[] = [];
let webgl2 = true;

class FakeOffscreen {
  constructor(public width: number, public height: number) {}
  getContext(kind: string) {
    return kind === "webgl2" && webgl2 ? fakeGl(glCalls) : null;
  }
}

/** A 2D dest that records which sources were blitted onto it. */
function dest() {
  const blits: unknown[] = [];
  const ctx = {
    canvas: { width: 400, height: 300 },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    save() {},
    restore() {},
    setTransform() {},
    drawImage(src: unknown) {
      blits.push(src);
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, blits };
}

const line = (x0: number, y0: number, x1: number, y1: number): SpineDot[] =>
  Array.from({ length: 6 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 5, y: y0 + ((y1 - y0) * i) / 5, r: 3 }));

describe("paintSdfSpines", () => {
  beforeEach(() => {
    vi.resetModules();
    glCalls = [];
    webgl2 = true;
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("draws strokes that do not touch in one pass", async () => {
    const { paintSdfSpines } = await import("./sdfPaint");
    const { ctx, blits } = dest();
    expect(paintSdfSpines(ctx, [line(10, 10, 60, 10), line(10, 80, 60, 80), line(200, 10, 260, 40)])).toBe(true);
    expect(blits).toHaveLength(1);
    // One coverage and one colour draw for the whole pass.
    expect(glCalls.filter((c) => c === "drawArraysInstanced")).toHaveLength(2);
  });

  it("starts a new pass when a stroke crosses the pending ones, so it stays on top", async () => {
    const { paintSdfSpines } = await import("./sdfPaint");
    const { ctx, blits } = dest();
    const strokes = [line(10, 50, 120, 50), line(60, 0, 60, 120), line(300, 200, 360, 220)];
    expect(paintSdfSpines(ctx, strokes)).toBe(true);
    // First stroke alone; the crossing one and the far one together.
    expect(blits).toHaveLength(2);
  });

  it("splits a pass before its surface outgrows what a GPU accepts", async () => {
    const { paintSdfSpines } = await import("./sdfPaint");
    const { ctx, blits } = dest();
    (ctx.canvas as { width: number; height: number }).width = 12000;
    // Two short strokes that never touch, 6000px apart: one surface would be too wide.
    expect(paintSdfSpines(ctx, [line(10, 10, 60, 10), line(6000, 10, 6050, 10)])).toBe(true);
    expect(blits).toHaveLength(2);
  });

  it("draws a single stroke too large for any surface with the 2D strip", async () => {
    const { paintSdfSpines } = await import("./sdfPaint");
    const { ctx, blits } = dest();
    (ctx.canvas as { width: number; height: number }).width = 12000;
    const fills: string[] = [];
    Object.assign(ctx, {
      beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {},
      fill() { fills.push("fill"); },
    });
    expect(paintSdfSpines(ctx, [line(10, 10, 9000, 10)])).toBe(true);
    expect(blits).toHaveLength(0);
    expect(fills.length).toBeGreaterThan(0);
  });

  it("returns false without WebGL2 so callers draw the 2D strip", async () => {
    webgl2 = false;
    const { paintSdfSpines } = await import("./sdfPaint");
    const { ctx, blits } = dest();
    expect(paintSdfSpines(ctx, [line(10, 10, 60, 10)])).toBe(false);
    expect(blits).toHaveLength(0);
  });
});
