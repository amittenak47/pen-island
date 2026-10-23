/**
 * Ink colour low-passed along the stroke. Each dot's colour comes from its
 * pressure (and blot, wash), so a real pen's dot-to-dot pressure noise gave
 * neighbouring capsules different colours, and every capsule's round edge
 * showed inside the fill as a ring. Two box passes over about a nib diameter
 * of travel (close to a triangle kernel) keep the slow shading and drop the
 * noise. Dots weigh by the travel they stand for, so a slow, dense stretch
 * does not outvote a fast one.
 *
 * A blot pool (a dot clearly wider than both neighbours, {@link isPoolDot})
 * keeps its own colour and stays out of its neighbours' means; the renderers
 * blend it in themselves.
 *
 * Every renderer smooths the same way, so live, saved, 2D and export agree.
 * A dot reads raw dots up to two nib radii (at most
 * {@link SMOOTH_LOOKAHEAD_PX}) ahead of it, so the live painters keep that
 * much of the tail unfrozen ({@link smoothStableTo}).
 */

import type { SpineDot } from "./instance";
import { INK_RGB } from "./style";

/** Widest half-window of one pass, device px. */
const REACH_CAP_PX = 40;
/** How far ahead (and behind) along the stroke a smoothed colour reads. */
export const SMOOTH_LOOKAHEAD_PX = REACH_CAP_PX * 2;
/** A pool is this much wider than both neighbours. */
const POOL_RATIO = 1.15;
/** Travel a dot stands for at least, px, so a still cluster still counts a little. */
const MIN_WEIGHT_PX = 0.05;

/** One pass's half-window: the dot's radius, so a nib diameter in all. */
const reachOf = (d: SpineDot) => Math.min(REACH_CAP_PX, Math.max(1, d.r));

/** Dot `i` is a blot pool: clearly wider than the dots on either side of it. */
export function isPoolDot(points: readonly SpineDot[], i: number): boolean {
  const p = points[i];
  if (!p) return false;
  const a = points[i - 1], b = points[i + 1];
  if (!a && !b) return false;
  return p.r > POOL_RATIO * Math.max(a?.r ?? 0, b?.r ?? 0);
}

let arc = new Float64Array(64);
let reach = new Float64Array(64);
let weight = new Float64Array(64);
let sums = new Float64Array(65 * 4);
let pass1 = new Float64Array(64 * 3);

function room(m: number) {
  if (arc.length >= m) return;
  let cap = arc.length;
  while (cap < m) cap *= 2;
  arc = new Float64Array(cap);
  reach = new Float64Array(cap);
  weight = new Float64Array(cap);
  sums = new Float64Array((cap + 1) * 4);
  pass1 = new Float64Array(cap * 3);
}

/** First index in [0, m) with arc >= v. */
function lowerBound(m: number, v: number): number {
  let lo = 0, hi = m;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arc[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One past the last index in [0, m) with arc <= v. */
function upperBound(m: number, v: number): number {
  let lo = 0, hi = m;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arc[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Weighted box mean of `src` (3 floats per index) over each index's window,
 * for k in [from, m). A window with no weight keeps the dot's own value.
 */
function boxPass(m: number, src: (k: number, c: number) => number, from: number, out: Float64Array) {
  sums.fill(0, 0, 4);
  for (let k = 0; k < m; k++) {
    const w = weight[k]!, o = k * 4, n = o + 4;
    for (let c = 0; c < 3; c++) sums[n + c] = sums[o + c]! + src(k, c) * w;
    sums[n + 3] = sums[o + 3]! + w;
  }
  for (let k = from; k < m; k++) {
    const a = lowerBound(m, arc[k]! - reach[k]!) * 4;
    const b = upperBound(m, arc[k]! + reach[k]!) * 4;
    const total = sums[b + 3]! - sums[a + 3]!;
    for (let c = 0; c < 3; c++) {
      out[k * 3 + c] = total > 1e-9 ? (sums[b + c]! - sums[a + c]!) / total : src(k, c);
    }
  }
}

/** Index of the first dot that a smoothed colour at `from` reads. */
function windowStart(points: readonly SpineDot[], from: number): number {
  let i = Math.max(0, Math.min(from, points.length - 1));
  let dist = 0;
  while (i > 0 && dist <= SMOOTH_LOOKAHEAD_PX) {
    const a = points[i - 1]!, b = points[i]!;
    dist += Math.hypot(b.x - a.x, b.y - a.y);
    i--;
  }
  return i;
}

/**
 * `points` with the colours of dots `[from, n)` smoothed along the stroke.
 * Dots before `from` are passed through as they are. Returns `points` itself
 * when no dot carries a colour.
 */
export function smoothSpineRgb(points: readonly SpineDot[], from = 0): readonly SpineDot[] {
  const n = points.length;
  if (n < 3 || from >= n) return points;
  const lo = windowStart(points, Math.max(0, from));
  let coloured = false;
  for (let i = lo; i < n && !coloured; i++) coloured = points[i]!.rgb !== undefined;
  if (!coloured) return points;
  const m = n - lo;
  room(m);
  arc[0] = 0;
  for (let k = 0; k < m; k++) {
    const p = points[lo + k]!;
    if (k > 0) {
      const q = points[lo + k - 1]!;
      arc[k] = arc[k - 1]! + Math.hypot(p.x - q.x, p.y - q.y);
    }
    reach[k] = reachOf(p);
  }
  // Half the hop on either side (one hop at the stroke's ends).
  const hop = (i: number) => {
    const a = points[i - 1], b = points[i];
    return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  };
  for (let k = 0; k < m; k++) {
    const i = lo + k;
    weight[k] = isPoolDot(points, i) ? 0 : (hop(i) + hop(i + 1)) / 2 + MIN_WEIGHT_PX;
  }
  const raw = (k: number, c: number) => (points[lo + k]!.rgb ?? INK_RGB)[c]!;
  // Pass 1 is read back to one reach before `from`; compute it from `lo`.
  boxPass(m, raw, 0, pass1);
  const out = new Float64Array(m * 3);
  const start = Math.max(0, from - lo);
  boxPass(m, (k, c) => pass1[k * 3 + c]!, start, out);
  const next = points.slice();
  for (let k = start; k < m; k++) {
    if (weight[k] === 0) continue;
    const o = k * 3;
    // 1/64 of a level: equal colours stay exactly equal through the sums'
    // rounding, so a uniform run is still one fill in 2D.
    const q = (v: number) => Math.round(v * 64) / 64;
    next[lo + k] = { ...points[lo + k]!, rgb: [q(out[o]!), q(out[o + 1]!), q(out[o + 2]!)] };
  }
  return next;
}

/**
 * The live painters' frozen limit once colours are smoothed: dots from
 * `stableTo` on can still change, and a smoothed colour reads raw dots up to
 * two reaches ahead, so dots within that distance before `stableTo` stay
 * live too.
 */
export function smoothStableTo(points: readonly SpineDot[], stableTo: number): number {
  // Dot i reads pass-1 values within its reach, each reading raw dots within
  // theirs: two reaches of the dots in between bound it.
  let i = Math.max(0, Math.min(stableTo, points.length - 1));
  let dist = 0;
  let reachMax = 0;
  while (i > 0) {
    reachMax = Math.max(reachMax, reachOf(points[i]!));
    if (dist > reachMax * 2) break;
    const a = points[i - 1]!, b = points[i]!;
    dist += Math.hypot(b.x - a.x, b.y - a.y);
    i--;
  }
  return i;
}

/**
 * Per-instance pool flags for the weighted blend: 1 when the hop's first
 * dot is a pool, 2 for its second. The shader then blends a pool disc in
 * at that end, strongest at its centre.
 */
export function poolFlags(points: readonly SpineDot[], a: number, b: number): number {
  return (isPoolDot(points, a) ? 1 : 0) | (isPoolDot(points, b) ? 2 : 0);
}
