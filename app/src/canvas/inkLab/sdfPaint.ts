/**
 * Replay committed strokes with the same WebGL capsules the live lab engine
 * uses, so a stroke looks the same after lift, scroll, zoom and reopen.
 *
 * Maps scene-space dots through the dest CTM (tile, overlay, host translate)
 * and blits in device pixels so clip() still applies — host-bound scroll and
 * page clip stay on the 2d context.
 */

import {
  emptyAabb,
  expandAabb,
  INSTANCE_FLOATS,
  writeInstance,
  type SpineDot,
  type StrokeAabb,
} from "./instance";
import { fillMiterStroke } from "./fallback";
import { tryCreateSdfRenderer, type SdfRenderer } from "./sdf";
import { INK_RGB } from "./style";

let pooled: SdfRenderer | null | undefined;
let inst = new Float32Array(64 * INSTANCE_FLOATS);

function peer(w: number, h: number): HTMLCanvasElement | null {
  if (typeof OffscreenCanvas === "function") {
    return new OffscreenCanvas(Math.max(1, w), Math.max(1, h)) as unknown as HTMLCanvasElement;
  }
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return null;
  }
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

function mapDot(t: DOMMatrix, d: SpineDot): SpineDot {
  const sx = Math.hypot(t.a, t.b) || 1;
  return {
    ...d,
    x: t.a * d.x + t.c * d.y + t.e,
    y: t.b * d.x + t.d * d.y + t.f,
    r: d.r * sx,
  };
}

function destSize(ctx: CanvasRenderingContext2D): { w: number; h: number } {
  const canvas = ctx.canvas;
  return {
    w: Math.max(1, canvas?.width ?? 1),
    h: Math.max(1, canvas?.height ?? 1),
  };
}

function finiteTransform(dest: CanvasRenderingContext2D): DOMMatrix | null {
  if (typeof dest.getTransform !== "function") return null;
  let t: DOMMatrix;
  try {
    t = dest.getTransform();
  } catch {
    return null;
  }
  if (!t || ![t.a, t.b, t.c, t.d, t.e, t.f].every(Number.isFinite)) return null;
  return t;
}

function renderer(): SdfRenderer | null {
  if (pooled?.isLost()) {
    pooled.destroy();
    pooled = undefined;
  }
  if (pooled === undefined) pooled = tryCreateSdfRenderer(1, 1, peer);
  return pooled;
}

/**
 * Largest surface side a pass may use. Export canvases can exceed what every
 * GPU accepts (8192 on the tablet); a larger buffer would be clamped and drawn
 * wrong, so a bigger group is split and a bigger single stroke uses the strip.
 */
const SURFACE_MAX_PX = 4096;

const overlaps = (a: StrokeAabb, b: StrokeAabb) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

type Mapped = { dots: SpineDot[]; box: StrokeAabb };

/** One coverage pass for strokes that do not touch, then one blit. */
function paintGroup(dest: CanvasRenderingContext2D, sdf: SdfRenderer, group: readonly Mapped[]) {
  const box = emptyAabb();
  let hops = 0;
  for (const s of group) {
    box.minX = Math.min(box.minX, s.box.minX);
    box.minY = Math.min(box.minY, s.box.minY);
    box.maxX = Math.max(box.maxX, s.box.maxX);
    box.maxY = Math.max(box.maxY, s.box.maxY);
    hops += Math.max(1, s.dots.length - 1);
  }
  const { w: destW, h: destH } = destSize(dest);
  const pad = 4;
  // Even origin: fwidth() works on 2x2 pixel quads, so an odd shift would
  // antialias edges differently from the live surface, which starts at 0.
  const x0 = Math.max(0, (Math.floor(box.minX) - pad) & ~1);
  const y0 = Math.max(0, (Math.floor(box.minY) - pad) & ~1);
  const x1 = Math.min(destW, Math.ceil(box.maxX) + pad);
  const y1 = Math.min(destH, Math.ceil(box.maxY) + pad);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 1 || h < 1) return;
  // Grow only: tiles reuse one surface instead of reallocating per tile.
  if (sdf.canvas.width < w || sdf.canvas.height < h) {
    sdf.resize(Math.max(w, sdf.canvas.width), Math.max(h, sdf.canvas.height));
  }
  if (inst.length < hops * INSTANCE_FLOATS) inst = new Float32Array(hops * 2 * INSTANCE_FLOATS);
  let n = 0;
  const shift = (d: SpineDot): SpineDot => ({ ...d, x: d.x - x0, y: d.y - y0 });
  for (const { dots } of group) {
    if (dots.length === 1) {
      const a = shift(dots[0]!);
      writeInstance(inst, n++, a, a, a.rgb ?? INK_RGB, a.rgb ?? INK_RGB);
      continue;
    }
    for (let i = 1; i < dots.length; i++) {
      const a = shift(dots[i - 1]!);
      const b = shift(dots[i]!);
      writeInstance(inst, n++, a, b, a.rgb ?? INK_RGB, b.rgb ?? INK_RGB);
    }
  }
  sdf.upload(inst, n);
  sdf.draw({ minX: 0, minY: 0, maxX: w, maxY: h });
  dest.save();
  dest.setTransform(1, 0, 0, 1, 0, 0);
  dest.drawImage(sdf.canvas, 0, 0, w, h, x0, y0, w, h);
  dest.restore();
}

/**
 * Paint committed strokes in order. Capsules inside one pass blend with MAX
 * (no beads, see {@link ./sdf.ts}), which would merge two crossing strokes, so
 * a stroke that touches the pending group starts a new pass: the later
 * stroke still lies over the earlier one. False when WebGL2 is unavailable;
 * the caller then draws the 2D strip.
 */
export function paintSdfSpines(
  dest: CanvasRenderingContext2D,
  strokes: readonly (readonly SpineDot[])[],
): boolean {
  if (strokes.length === 0) return true;
  const transform = finiteTransform(dest);
  if (!transform) return false;
  const sdf = renderer();
  if (!sdf) {
    pooled = null;
    return false;
  }
  let group: Mapped[] = [];
  const union = emptyAabb();
  const flush = () => {
    if (group.length > 0) paintGroup(dest, sdf, group);
    group = [];
    Object.assign(union, emptyAabb());
  };
  const fits = (b: StrokeAabb) => b.maxX - b.minX <= SURFACE_MAX_PX && b.maxY - b.minY <= SURFACE_MAX_PX;
  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    const dots = stroke.map((d) => mapDot(transform, d));
    const box = emptyAabb();
    for (const d of dots) expandAabb(box, d);
    if (!fits(box)) {
      flush();
      fillMiterStroke(dest, stroke, null, stroke[0]!.rgb ?? INK_RGB);
      continue;
    }
    const grown = {
      minX: Math.min(union.minX, box.minX), minY: Math.min(union.minY, box.minY),
      maxX: Math.max(union.maxX, box.maxX), maxY: Math.max(union.maxY, box.maxY),
    };
    if (group.some((g) => overlaps(g.box, box)) || !fits(grown)) {
      flush();
      Object.assign(grown, box);
    }
    group.push({ dots, box });
    Object.assign(union, grown);
  }
  flush();
  return true;
}

/** One stroke, with an optional held tip past the last dot. */
export function paintSdfSpine(
  dest: CanvasRenderingContext2D,
  spine: readonly SpineDot[],
  tip: SpineDot | null,
): boolean {
  if (spine.length === 0 && !tip) return true;
  return paintSdfSpines(dest, [tip ? [...spine, tip] : spine]);
}
