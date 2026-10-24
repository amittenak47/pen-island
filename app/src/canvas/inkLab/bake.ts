/**
 * Spine bake. Lift uses {@link bakeSpine}. Live reshape uses
 * {@link reshapeLiveSpine} from paint so While Writing only tidies the tail.
 * Default: RDP + Chaikin + expandInkTurns. Optional clothoid after that,
 * even when Chaikin is off, ~3ms budget.
 */

import {
  INK_SMOOTHING_DEFAULT,
  smoothInkPoints,
  smoothLiveInkPoints,
  type LiveSmoothCache,
} from "../inkSmoothing";
import { expandInkTurns, type ScenePoint } from "../rasterInk";

import type { SpineDot } from "./instance";

export const CLOTHOID_BUDGET_MS = 3;

export type BakeKind = "catmull" | "clothoid";

export type BakeResult = {
  points: SpineDot[];
  bake: BakeKind;
  bakeMs: number;
};

function toScene(d: SpineDot, pressure = 0.5): ScenePoint {
  return {
    x: d.x,
    y: d.y,
    pressure: d.p ?? pressure,
    ...(d.slow != null ? { slowness: d.slow } : {}),
  };
}

function meanRadius(spine: readonly SpineDot[], from = 0): number {
  const n = spine.length;
  if (n === 0) return 4;
  const start = Math.max(0, Math.min(from, n - 1));
  let s = 0;
  for (let i = start; i < n; i++) s += spine[i]!.r;
  return s / Math.max(1, n - start);
}

function syncRawScene(rawScene: ScenePoint[], spine: readonly SpineDot[], appendOnly = false): void {
  const n = spine.length;
  for (let i = appendOnly ? Math.max(0, rawScene.length - 1) : 0; i < n; i++) {
    const d = spine[i]!;
    const p = rawScene[i];
    if (!p) {
      rawScene[i] = {
        x: d.x,
        y: d.y,
        pressure: d.p ?? 0.5,
        ...(d.slow != null ? { slowness: d.slow } : {}),
      };
      continue;
    }
    p.x = d.x;
    p.y = d.y;
    p.pressure = d.p ?? 0.5;
    if (d.slow != null) p.slowness = d.slow;
    else delete p.slowness;
  }
  rawScene.length = n;
}

/** Hop index where the live-smooth tail starts (join into the frozen prefix). */
export function liveSmoothFrom(cache: LiveSmoothCache | null): number {
  const frozen = cache?.prefix.length ?? 0;
  return frozen > 1 ? frozen - 1 : 0;
}

type LiveRadii = {
  acc: number[];
  /** Per baked point: arc walked along the baked path, and the src hop it maps into. */
  walked: number[];
  indices: number[];
  /** Per baked point: the next src dot still to place, and `out.length` after it. */
  nextSrc: number[];
  ends: number[];
  points: SpineDot[];
};
const liveRadii = new WeakMap<LiveSmoothCache, LiveRadii>();

/** Width, colour and the rest of `a` -> `b` at `t`, at a baked position. */
function styleBetween(x: number, y: number, a: SpineDot, b: SpineDot, t: number): SpineDot {
  const rgbA = a.rgb;
  const rgbB = b.rgb;
  const rgb =
    rgbA && rgbB
      ? ([
          rgbA[0] + (rgbB[0] - rgbA[0]) * t,
          rgbA[1] + (rgbB[1] - rgbA[1]) * t,
          rgbA[2] + (rgbB[2] - rgbA[2]) * t,
        ] as [number, number, number])
      : rgbA ?? rgbB;
  const p0 = a.p ?? 0.5;
  const p1 = b.p ?? p0;
  const s0 = a.slow;
  const s1 = b.slow;
  return {
    x,
    y,
    r: a.r + (b.r - a.r) * t,
    rgb,
    a: (a.a ?? 1) + ((b.a ?? 1) - (a.a ?? 1)) * t,
    p: p0 + (p1 - p0) * t,
    slow: s0 != null && s1 != null ? s0 + (s1 - s0) * t : s0 ?? s1,
  };
}

/** A src dot's own style, moved onto the baked path. */
function placed(d: SpineDot, x: number, y: number): SpineDot {
  return { ...d, x, y, rgb: d.rgb ? [d.rgb[0], d.rgb[1], d.rgb[2]] : undefined };
}

/**
 * The smoothed path with the stroke's own dots on it. Smoothing simplifies:
 * a straight run keeps two points, and styling those two from the dots they
 * map to spread a held pool or a pressure swell along the whole run as one
 * taper. So every src dot is also placed on the baked path, at its arc
 * position, with its own width, colour and pool, and the baked points
 * between them take the style in between.
 */
function radiiAlong(
  src: readonly SpineDot[],
  baked: readonly ScenePoint[],
  memo?: LiveRadii,
  frozen = 0,
): SpineDot[] {
  if (baked.length === 0) return [];
  if (src.length === 0) {
    return baked.map((p) => ({ x: p.x, y: p.y, r: 4 }));
  }
  const acc = memo?.acc ?? [0];
  for (let i = Math.max(1, acc.length - 1); i < src.length; i++) {
    acc[i] = acc[i - 1]! + Math.hypot(src[i]!.x - src[i - 1]!.x, src[i]!.y - src[i - 1]!.y);
  }
  acc.length = src.length;
  const total = acc[acc.length - 1]! || 1;
  const last = baked.length - 1;
  // The last baked point is the pen: it always moves, so it is never frozen.
  const start = memo ? Math.min(frozen, memo.ends.length, last) : 0;
  const out: SpineDot[] = memo ? memo.points : [];
  out.length = start > 0 ? memo!.ends[start - 1]! : 0;
  let j = start > 0 ? memo!.indices[start - 1]! : 0;
  let walked = start > 0 ? memo!.walked[start - 1]! : 0;
  let next = start > 0 ? memo!.nextSrc[start - 1]! : 1;
  let prevTarget = start > 0 ? Math.min(walked, total) : 0;
  for (let i = start; i < baked.length; i++) {
    const p = baked[i]!;
    if (i > 0) walked += Math.hypot(p.x - baked[i - 1]!.x, p.y - baked[i - 1]!.y);
    // Arc walked on the baked path is arc on the stroke, so a frozen prefix
    // keeps its mapping; the pen end takes the rest of the stroke.
    const target = i === last ? total : Math.min(walked, total);
    if (i > 0) {
      const q = baked[i - 1]!;
      const span = target - prevTarget;
      // The stroke's own dots that fall on this baked hop.
      while (next < src.length - 1 && acc[next]! < target) {
        const f = span > 1e-6 ? (acc[next]! - prevTarget) / span : 0;
        out.push(placed(src[next]!, q.x + (p.x - q.x) * f, q.y + (p.y - q.y) * f));
        next += 1;
      }
    }
    while (j + 1 < acc.length && acc[j + 1]! < target) j += 1;
    let dot: SpineDot;
    if (i === 0) dot = placed(src[0]!, p.x, p.y);
    else if (i === last) dot = placed(src[src.length - 1]!, p.x, p.y);
    else {
      const a = src[Math.min(j, src.length - 1)]!;
      const b = src[Math.min(j + 1, src.length - 1)]!;
      const span = (acc[j + 1] ?? acc[j]!) - acc[j]!;
      dot = styleBetween(p.x, p.y, a, b, span > 1e-6 ? (target - acc[j]!) / span : 0);
    }
    out.push(dot);
    prevTarget = target;
    if (memo) {
      memo.walked[i] = walked;
      memo.indices[i] = j;
      memo.nextSrc[i] = next;
      memo.ends[i] = out.length;
    }
  }
  if (memo) {
    memo.acc = acc;
    memo.points = out;
    memo.walked.length = baked.length;
    memo.indices.length = baked.length;
    memo.nextSrc.length = baked.length;
    memo.ends.length = baked.length;
  }
  return out;
}

export function bakeCatmull(
  points: readonly ScenePoint[],
  nibWidth: number,
  strength = INK_SMOOTHING_DEFAULT,
): ScenePoint[] {
  if (strength <= 0) return [...points];
  const smoothed = smoothInkPoints(points, strength, Math.max(nibWidth, 1e-6));
  return expandInkTurns(smoothed);
}

/** Fresnel C,S for ∫_0^t cos(u²) du and sin(u²) du. Short series, not a step loop. */
export function fresnelCS(t: number): { c: number; s: number } {
  const x = t;
  const x2 = x * x;
  let c = 0;
  let s = 0;
  let pow = x;
  let sign = 1;
  let fact = 1;
  for (let n = 0; n < 10; n++) {
    const n2 = 2 * n;
    c += sign * pow / (fact * (4 * n + 1));
    pow *= x2;
    fact *= n2 + 1;
    s += sign * pow / (fact * (4 * n + 3));
    pow *= x2;
    fact *= n2 + 2;
    sign = -sign;
  }
  return { c, s };
}

function heading(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}

function sampleClothoid(
  a: SpineDot,
  b: SpineDot,
  theta0: number,
  theta1: number,
): ScenePoint[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-4) return [toScene(b)];
  let dth = theta1 - theta0;
  while (dth > Math.PI) dth -= Math.PI * 2;
  while (dth < -Math.PI) dth += Math.PI * 2;
  if (Math.abs(dth) < 0.04) return [toScene(b)];
  const n = Math.max(3, Math.min(18, Math.ceil(Math.abs(dth) / 0.18)));
  const sigma = (2 * dth) / (chord * chord);
  const scale = Math.sqrt(2 / Math.max(Math.abs(sigma), 1e-8));
  const rot = theta0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const end = fresnelCS(chord / scale);
  const endLen = Math.hypot(end.c, end.s) || 1;
  const fit = chord / (endLen * scale);
  const out: ScenePoint[] = [];
  for (let i = 1; i <= n; i++) {
    const s = (i / n) * chord;
    const fs = fresnelCS(s / scale);
    const lx = fs.c * scale * fit;
    const ly = (sigma < 0 ? -fs.s : fs.s) * scale * fit;
    const x = a.x + lx * cos - ly * sin;
    const y = a.y + lx * sin + ly * cos;
    if (i === n) {
      out.push(toScene(b));
    } else {
      out.push({ x, y, pressure: 0.5 });
    }
  }
  return out;
}

export function bakeClothoid(spine: readonly SpineDot[]): ScenePoint[] {
  if (spine.length < 2) return spine.map((p) => toScene(p));
  const out: ScenePoint[] = [toScene(spine[0]!)];
  for (let i = 1; i < spine.length; i++) {
    const prev = spine[i - 1]!;
    const cur = spine[i]!;
    const nxt = spine[i + 1];
    const th0 = heading(prev.x, prev.y, cur.x, cur.y);
    const th1 = nxt ? heading(cur.x, cur.y, nxt.x, nxt.y) : th0;
    out.push(...sampleClothoid(prev, cur, th0, th1));
  }
  return out;
}

export function bakeSpine(
  spine: readonly SpineDot[],
  opts: { clothoid?: boolean; smoothing?: number } = {},
): BakeResult {
  const t0 = performance.now();
  const strength = opts.smoothing ?? INK_SMOOTHING_DEFAULT;
  let points: SpineDot[];
  let bake: BakeKind = "catmull";
  if (strength > 0) {
    const scenes = spine.map((p) => toScene(p));
    const nib = meanRadius(spine) * 2;
    points = radiiAlong(spine, bakeCatmull(scenes, nib, strength));
  } else {
    points = spine.map((p) => ({ ...p }));
  }
  if (opts.clothoid && points.length >= 3) {
    const c0 = performance.now();
    const cloth = bakeClothoid(points);
    if (performance.now() - c0 <= CLOTHOID_BUDGET_MS) {
      points = radiiAlong(points, cloth);
      bake = "clothoid";
    }
  }
  return {
    points,
    bake,
    bakeMs: performance.now() - t0,
  };
}

/**
 * Same Chaikin as lift, for the open stroke. Endpoints stay put so the nib
 * still tracks the pen. Safe from rAF — does not write the engine spine.
 */
export function reshapeSpine(
  spine: readonly SpineDot[],
  strength: number,
): SpineDot[] {
  if (strength <= 0 || spine.length < 3) return spine.map((p) => ({ ...p }));
  const scenes = spine.map((p) => toScene(p));
  const nib = meanRadius(spine) * 2;
  return radiiAlong(spine, bakeCatmull(scenes, nib, strength));
}

/**
 * While Writing: freeze the prefix and Chaikin only the live-smooth tail.
 * `rawScene` must be a stable array (same identity across paints) so the
 * cache can keep its source pointer.
 */
export function reshapeLiveSpine(
  spine: readonly SpineDot[],
  strength: number,
  cache: LiveSmoothCache | null,
  rawScene: ScenePoint[],
): { points: SpineDot[]; cache: LiveSmoothCache | null; from: number } {
  if (strength <= 0 || spine.length < 3) {
    return { points: spine.map((p) => ({ ...p })), cache: null, from: 0 };
  }
  syncRawScene(rawScene, spine, cache != null && rawScene.length <= spine.length);
  const fromHint = cache?.anchor ?? 0;
  const nib = meanRadius(spine, fromHint) * 2;
  const frozenBefore = liveSmoothFrom(cache);
  const live = smoothLiveInkPoints(rawScene, strength, nib, cache);
  // Upload from the boundary that was painted LAST time. The new cache can
  // freeze multiple segments after a delayed frame; starting at its new
  // boundary would leave those segments stale or absent in the GPU buffer.
  const from = live.cache === cache ? frozenBefore : 0;
  let memo = live.cache ? liveRadii.get(live.cache) : undefined;
  // Geometry and styling freeze together. Rewalking/reallocating all radii
  // and RGB values each frame made long strokes slower despite tail-only GPU work.
  const frozen = memo ? frozenBefore : 0;
  if (!memo && live.cache) {
    memo = { acc: [0], walked: [], indices: [], nextSrc: [], ends: [], points: [] };
    liveRadii.set(live.cache, memo);
  }
  const points = radiiAlong(spine, live.points, memo, frozen);
  // `from` counts baked points; the painter counts output dots, and each
  // baked point may now carry the stroke's own dots before it.
  const fromDot = from > 0 && memo ? memo.ends[from - 1]! - 1 : 0;
  return {
    points,
    cache: live.cache,
    from: fromDot,
  };
}
