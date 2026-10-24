/** One round-cone instance. CPU append, GPU instanced draw. */

export const INSTANCE_FLOATS = 15;

/**
 * A blot's texture seed: its starting pressure as the byte the stroke store
 * keeps, so live, saved and every zoom draw the same rim and grain.
 */
export function poolSeed(d: SpineDot): number {
  const p = d.p ?? 0.5;
  return Math.round(Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0.5)) * 255);
}

export type SpineDot = {
  x: number;
  y: number;
  r: number;
  rgb?: [number, number, number];
  /** Coverage 0–1. Absent means opaque. */
  a?: number;
  /** Stylus pressure, for InkOp replay. */
  p?: number;
  /** Pace 0–1, for InkOp replay. */
  slow?: number;
  /**
   * Blot pool growth 0–1 when the pen was held here. Renderers keep a pool's
   * own colour and blend it in as a pool (see ./inkSmooth.ts).
   */
  pool?: number;
};

export function writeInstance(
  data: Float32Array,
  index: number,
  a: SpineDot,
  b: SpineDot,
  c0: readonly [number, number, number],
  c1: readonly [number, number, number],
  /** Blot pool at the hop's first (1) and second (2) dot; see ./inkSmooth.ts. */
  pools = 0,
): void {
  const o = index * INSTANCE_FLOATS;
  data[o] = a.x;
  data[o + 1] = a.y;
  data[o + 2] = a.r;
  data[o + 3] = b.x;
  data[o + 4] = b.y;
  data[o + 5] = b.r;
  data[o + 6] = c0[0];
  data[o + 7] = c0[1];
  data[o + 8] = c0[2];
  data[o + 9] = c1[0];
  data[o + 10] = c1[1];
  data[o + 11] = c1[2];
  data[o + 12] = pools;
  // Seed in the integer part, the pool's growth (0-1) in the fraction.
  data[o + 13] = poolSeed(a) + Math.min(0.999, Math.max(0, a.pool ?? 0));
  data[o + 14] = poolSeed(b) + Math.min(0.999, Math.max(0, b.pool ?? 0));
}

export type StrokeAabb = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export function expandAabb(box: StrokeAabb, p: SpineDot): void {
  const r = p.r + 2;
  box.minX = Math.min(box.minX, p.x - r);
  box.minY = Math.min(box.minY, p.y - r);
  box.maxX = Math.max(box.maxX, p.x + r);
  box.maxY = Math.max(box.maxY, p.y + r);
}

export function emptyAabb(): StrokeAabb {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}
