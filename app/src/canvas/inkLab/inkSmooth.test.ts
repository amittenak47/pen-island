import { describe, expect, it } from "vitest";

import type { SpineDot } from "./instance";
import { isPoolDot, smoothSpineRgb, smoothStableTo } from "./inkSmooth";

/** A slow line whose colour jumps dot to dot, like a real pen's pressure noise. */
function noisy(n: number, r = 20): SpineDot[] {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => {
    const v = 40 + rand() * 120;
    return { x: 10 + i * 0.8, y: 50, r, rgb: [v, v, 200] as [number, number, number] };
  });
}

const step = (dots: readonly SpineDot[]) => {
  let worst = 0;
  for (let i = 1; i < dots.length; i++) worst = Math.max(worst, Math.abs(dots[i]!.rgb![0] - dots[i - 1]!.rgb![0]));
  return worst;
};

describe("ink colour smoothing", () => {
  it("drops dot-to-dot colour steps to a level that does not show", () => {
    const raw = noisy(400);
    expect(step(raw)).toBeGreaterThan(60);
    // Away from the ends, where the window is whole.
    expect(step(smoothSpineRgb(raw).slice(60, 340))).toBeLessThan(2);
  });

  it("keeps a uniform colour and leaves dots without colour alone", () => {
    const flat = noisy(50).map((d) => ({ ...d, rgb: [30, 40, 50] as [number, number, number] }));
    for (const d of smoothSpineRgb(flat)) expect(d.rgb!.map(Math.round)).toEqual([30, 40, 50]);
    const bare = flat.map(({ rgb: _rgb, ...d }) => d);
    expect(smoothSpineRgb(bare)).toBe(bare);
  });

  it("gives frozen dots the same colour live as once the stroke is saved", () => {
    const full = noisy(300);
    const saved = smoothSpineRgb(full);
    // 40 dots are 32 px: shorter than the window, so nothing freezes yet.
    expect(smoothStableTo(full.slice(0, 40), 37)).toBe(0);
    for (const n of [120, 250]) {
      const live = full.slice(0, n);
      const frozen = smoothStableTo(live, n - 3);
      expect(frozen).toBeGreaterThan(0);
      expect(frozen).toBeLessThan(n - 3);
      const partial = smoothSpineRgb(live, Math.max(0, frozen - 30));
      for (let i = Math.max(0, frozen - 30); i <= frozen; i++) {
        // Dots exactly a reach apart can tie at a window edge and round
        // either way: well under a colour level.
        expect(Math.abs(partial[i]!.rgb![0] - saved[i]!.rgb![0])).toBeLessThan(0.05);
      }
    }
  });

  it("leaves a blot pool its own colour and keeps it out of the line's", () => {
    const line = noisy(200).map((d) => ({ ...d, rgb: [100, 120, 220] as [number, number, number] }));
    line[100] = { ...line[100]!, r: 30, rgb: [40, 60, 180] };
    const out = smoothSpineRgb(line);
    expect(isPoolDot(line, 100)).toBe(true);
    expect(isPoolDot(line, 99)).toBe(false);
    expect(out[100]!.rgb).toEqual([40, 60, 180]);
    expect(out[99]!.rgb).toEqual([100, 120, 220]);
  });

  it("weighs dots by travel, so a slow dense stretch does not outvote a fast one", () => {
    // 50 dots crowded into 5 px, then 10 dots over 50 px, two colours.
    const dense = Array.from({ length: 50 }, (_, i) => ({ x: i * 0.1, y: 0, r: 20, rgb: [0, 0, 0] as [number, number, number] }));
    const sparse = Array.from({ length: 10 }, (_, i) => ({ x: 5 + (i + 1) * 5, y: 0, r: 20, rgb: [200, 200, 200] as [number, number, number] }));
    const out = smoothSpineRgb([...dense, ...sparse]);
    // At the join both stretches cover about the same travel in the window.
    const join = out[49]!.rgb![0];
    expect(join).toBeGreaterThan(60);
    expect(join).toBeLessThan(140);
  });

  it("keeps only about two nib radii of the tail live", () => {
    const thin = noisy(300, 3);
    const frozen = smoothStableTo(thin, 297);
    // Dots are 0.8 px apart: two 3 px reaches is about 8 dots.
    expect(297 - frozen).toBeLessThan(12);
  });
});
