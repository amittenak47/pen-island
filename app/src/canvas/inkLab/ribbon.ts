import { clipBlitRect, CLIP_BLIT_PAD } from "./clipBlit";
import { fillMiterStroke } from "./fallback";
import { emptyAabb, expandAabb, type SpineDot, type StrokeAabb } from "./instance";
import { INK_RGB } from "./style";

/** Join touching hop runs this close together into one span. */
const RANGE_MERGE_GAP = 16;

/**
 * The 2D live path, for when WebGL2 will not start. Same contract as
 * {@link createLiveSdf}: each paint clears the moving tail box and redraws
 * every hop that reaches it, as one fill, over the committed snap. One fill
 * means one antialiased edge, so frozen chunks no longer meet in a seam, and
 * the cost of a frame does not grow with the stroke.
 */
export function createLiveRibbon() {
  let frozen = 0;
  let previous: StrokeAabb | null = null;
  /** Per hop: minX, minY, maxX, maxY, padded for the widest miter. */
  let boxes = new Float32Array(64 * 4);
  const ranges: number[] = [];

  const clear = () => {
    frozen = 0;
    previous = null;
  };

  const boxHops = (points: readonly SpineDot[], from: number) => {
    const hops = points.length - 1;
    if (boxes.length < hops * 4) {
      const next = new Float32Array(Math.max(hops * 4, boxes.length * 2));
      next.set(boxes);
      boxes = next;
    }
    for (let i = Math.max(0, from); i < hops; i++) {
      const a = points[i]!, b = points[i + 1]!;
      // A miter vertex reaches 2r from its dot.
      const pad = Math.max(a.r, b.r) * 2 + 2;
      const o = i * 4;
      boxes[o] = Math.min(a.x, b.x) - pad;
      boxes[o + 1] = Math.min(a.y, b.y) - pad;
      boxes[o + 2] = Math.max(a.x, b.x) + pad;
      boxes[o + 3] = Math.max(a.y, b.y) + pad;
    }
  };

  /** Point spans, inclusive [from, to] pairs, of the hops that reach `rect`. */
  const touching = (points: readonly SpineDot[], rect: { x: number; y: number; w: number; h: number }) => {
    ranges.length = 0;
    if (points.length === 1) {
      ranges.push(0, 0);
      return ranges;
    }
    const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.w, y1 = rect.y + rect.h;
    for (let i = 0; i < points.length - 1; i++) {
      const o = i * 4;
      if (boxes[o]! > x1 || boxes[o + 2]! < x0 || boxes[o + 1]! > y1 || boxes[o + 3]! < y0) continue;
      const n = ranges.length;
      if (n > 0 && i - ranges[n - 1]! <= RANGE_MERGE_GAP) ranges[n - 1] = i + 1;
      else ranges.push(i, i + 1);
    }
    return ranges;
  };

  const boxOf = (points: readonly SpineDot[], from: number): StrokeAabb => {
    const box = emptyAabb();
    for (let i = from; i < points.length; i++) {
      const p = points[i]!;
      expandAabb(box, { ...p, r: p.r * 2 });
    }
    return box;
  };

  return {
    clear,
    paint(host: HTMLCanvasElement, snap: HTMLCanvasElement | null,
      points: readonly SpineDot[], stableTo: number): StrokeAabb {
      const ctx = host.getContext("2d")!;
      if (points.length === 0) return emptyAabb();
      const next = Math.max(frozen, Math.min(stableTo, points.length - 1));
      // Hops past the frozen prefix can still change; the one before them
      // shares a dot with the first of them.
      boxHops(points, frozen - 1);
      // Old tail plus newly frozen span, never the accumulated stroke box.
      const dirty = boxOf(points, frozen);
      if (previous) {
        dirty.minX = Math.min(dirty.minX, previous.minX);
        dirty.minY = Math.min(dirty.minY, previous.minY);
        dirty.maxX = Math.max(dirty.maxX, previous.maxX);
        dirty.maxY = Math.max(dirty.maxY, previous.maxY);
      }
      frozen = next;
      previous = boxOf(points, frozen);
      const clip = clipBlitRect(dirty, host.width, host.height, CLIP_BLIT_PAD);
      if (!clip) return dirty;
      const { x, y, w, h } = clip;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.clearRect(x, y, w, h);
      if (snap) ctx.drawImage(snap, x, y, w, h, x, y, w, h);
      // Crossing an older part of this stroke must not erase it: every hop
      // that reaches the box is redrawn with the tail, in the same fill.
      fillMiterStroke(ctx, points, null, INK_RGB, { ranges: touching(points, clip) });
      ctx.restore();
      return dirty;
    },
  };
}
