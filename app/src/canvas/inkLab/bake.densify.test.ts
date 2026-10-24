import { describe, expect, it } from "vitest";

import { bakeSpine, reshapeLiveSpine } from "./bake";
import type { SpineDot } from "./instance";

/** A straight line, so smoothing keeps few points, with a held pool in the middle. */
function line(): SpineDot[] {
  return Array.from({ length: 60 }, (_, i) => ({
    x: 20 + i * 5,
    y: 80,
    r: i === 30 ? 24 : 8 + (i % 7) * 0.5,
    rgb: (i === 30 ? [20, 40, 160] : [80, 110, 220]) as [number, number, number],
    p: 0.5,
    ...(i === 30 ? { pool: 1 } : {}),
  }));
}

const poolOf = (dots: readonly SpineDot[]) => dots.filter((d) => (d.pool ?? 0) > 0);

describe("smoothing keeps the stroke's own dots", () => {
  it("On Lift keeps a held pool whole, at its own width and colour", () => {
    const { points } = bakeSpine(line(), { smoothing: 0.35 });
    const pools = poolOf(points);
    expect(pools).toHaveLength(1);
    expect(pools[0]!.r).toBe(24);
    expect(pools[0]!.rgb).toEqual([20, 40, 160]);
    // Widths away from the pool stay the line's, not a taper into it.
    expect(Math.max(...points.slice(0, 20).map((d) => d.r))).toBeLessThan(12);
  });

  it("Live keeps the pool and the tip, and does not collapse to two points", () => {
    const spine = line();
    const raw: Parameters<typeof reshapeLiveSpine>[3] = [];
    const { points } = reshapeLiveSpine(spine, 0.35, null, raw);
    expect(points.length).toBeGreaterThanOrEqual(spine.length);
    expect(poolOf(points)).toHaveLength(1);
    const end = points[points.length - 1]!;
    expect(end.x).toBeCloseTo(spine[spine.length - 1]!.x, 0);
    expect(end.r).toBe(spine[spine.length - 1]!.r);
  });
});
