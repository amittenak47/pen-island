import { describe, expect, it } from "vitest";

import type { InkDrawOp } from "../rasterInk";
import { poolSeed } from "./instance";
import { labSpineFromDrawOp } from "./replay";

const op = (halts?: InkDrawOp["blotHalts"]): InkDrawOp => ({
  kind: "draw",
  color: "#1d4fd8",
  baseWidth: 20,
  maxFullness: 1,
  pressureClip: 1,
  pressureSensitive: false,
  speedInk: 0,
  speedBlotBlend: 1,
  points: Array.from({ length: 20 }, (_, i) => ({ x: 10 + i * 5, y: 40, pressure: 0.5, radius: i === 10 ? 14 : 8 })),
  ...(halts ? { blotHalts: halts } : {}),
});

describe("replayed blot pools", () => {
  it("marks the held point as a pool and darkens it as the live pen did", () => {
    const plain = labSpineFromDrawOp(op());
    const held = labSpineFromDrawOp(op([{ x: 60, y: 40, grow: 1 }]));
    expect(held[10]!.pool).toBe(1);
    expect(held[9]!.pool).toBeUndefined();
    const lum = (c: readonly number[]) => c[0]! + c[1]! + c[2]!;
    expect(lum(held[10]!.rgb!)).toBeLessThan(lum(plain[10]!.rgb!) - 10);
    expect(held[9]!.rgb).toEqual(plain[9]!.rgb);
  });

  it("leaves a stroke without halts alone", () => {
    expect(labSpineFromDrawOp(op()).some((d) => d.pool !== undefined)).toBe(false);
  });

  it("gives a blot the same texture seed live and after the store rounds its pressure", () => {
    for (const p of [0.1234, 0.4235294117647059, 0.61, 0.999]) {
      const stored = Math.round(p * 255) / 255;
      expect(poolSeed({ x: 0, y: 0, r: 1, p: stored })).toBe(poolSeed({ x: 0, y: 0, r: 1, p }));
    }
  });

  it("draws a blot with the random seed its halt was saved with", () => {
    const held = labSpineFromDrawOp(op([{ x: 60, y: 40, grow: 1, seed: 1234 }]));
    expect(held[10]!.seed).toBe(1234);
    expect(poolSeed(held[10]!)).toBe(1234);
    // Strokes saved before seeds keep the pressure fallback.
    const old = labSpineFromDrawOp(op([{ x: 60, y: 40, grow: 1 }]));
    expect(old[10]!.seed).toBeUndefined();
    expect(poolSeed(old[10]!)).toBe(Math.round(0.5 * 255));
  });
});
