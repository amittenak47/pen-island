import { clipBlitRect, CLIP_BLIT_PAD, SDF_SCISSOR_PAD, type PixelRect } from "./clipBlit";
import {
  emptyAabb,
  expandAabb,
  INSTANCE_FLOATS,
  writeInstance,
  type SpineDot,
  type StrokeAabb,
} from "./instance";
import { poolFlags, smoothSpineRgb, smoothStableTo } from "./inkSmooth";
import type { SdfRenderer } from "./sdf";
import { INK_RGB } from "./style";

function inkOf(d: SpineDot): readonly [number, number, number] {
  return d.rgb ?? INK_RGB;
}

/** Join touching instance runs this close together into one draw. */
const RANGE_MERGE_GAP = 16;
/**
 * Widest box rendered at once. Larger boxes go in chunks, so the weighted
 * blend's float buffer (16 bytes a pixel) stays at most this square.
 */
export const LIVE_CHUNK_PX = 1024;

/**
 * Live WebGL2 capsules with the same contract as {@link createLiveRibbon}.
 * Each paint rewrites the hops past the frozen prefix, then renders only the
 * moving tail box: every capsule that reaches it, as a few contiguous ranges,
 * into a GL surface the size of that box, and blits it onto the host. The
 * host keeps the rest of the stroke. Neither the GPU work nor the surface a
 * frame reads back grows with the stroke; a host-sized surface meant copying
 * its whole buffer every frame. MAX blending is order-free, so the pixels
 * match redrawing every capsule.
 */
export function createLiveSdf(sdf: SdfRenderer) {
  let inst = new Float32Array(32 * INSTANCE_FLOATS);
  /** Per instance: minX, minY, maxX, maxY of its quad. */
  let boxes = new Float32Array(32 * 4);
  const ranges: number[] = [];
  let frozen = 0;
  let previous: StrokeAabb | null = null;
  /** The GPU instance buffer does not hold this stroke yet. */
  let stale = true;

  const ensure = (n: number) => {
    if (n * INSTANCE_FLOATS <= inst.length) return;
    let cap = inst.length / INSTANCE_FLOATS;
    while (cap < n) cap *= 2;
    const next = new Float32Array(cap * INSTANCE_FLOATS);
    next.set(inst);
    inst = next;
    const nextBoxes = new Float32Array(cap * 4);
    nextBoxes.set(boxes);
    boxes = nextBoxes;
  };

  const writeOne = (i: number, a: SpineDot, b: SpineDot, pools = 0) => {
    writeInstance(inst, i, a, b, inkOf(a), inkOf(b), pools);
    // The shader's quad is the hop box grown by the radius + 2.5 px (a pool's
    // rim bulges 5% further).
    const pad = Math.max(a.r, b.r) * (pools > 0 ? 1.05 : 1) + 3;
    const o = i * 4;
    boxes[o] = Math.min(a.x, b.x) - pad;
    boxes[o + 1] = Math.min(a.y, b.y) - pad;
    boxes[o + 2] = Math.max(a.x, b.x) + pad;
    boxes[o + 3] = Math.max(a.y, b.y) + pad;
  };

  /** Instance runs whose quads reach the scissored `box`, as flat [from, to) pairs. */
  const touching = (box: StrokeAabb, count: number): number[] => {
    ranges.length = 0;
    const x0 = box.minX - SDF_SCISSOR_PAD, y0 = box.minY - SDF_SCISSOR_PAD;
    const x1 = box.maxX + SDF_SCISSOR_PAD, y1 = box.maxY + SDF_SCISSOR_PAD;
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      if (boxes[o]! > x1 || boxes[o + 2]! < x0 || boxes[o + 1]! > y1 || boxes[o + 3]! < y0) continue;
      const n = ranges.length;
      if (n > 0 && i - ranges[n - 1]! <= RANGE_MERGE_GAP) ranges[n - 1] = i + 1;
      else ranges.push(i, i + 1);
    }
    return ranges;
  };

  /** Hops `[from, n-1)`, or one round dot for a lone sample. Returns instance count. */
  const write = (raw: readonly SpineDot[], from: number): number => {
    const points = smoothSpineRgb(raw, from);
    const n = points.length;
    if (n === 1) {
      ensure(1);
      const p = points[0]!;
      writeOne(0, p, p);
      return 1;
    }
    ensure(n);
    for (let i = from; i < n - 1; i++) writeOne(i, points[i]!, points[i + 1]!, poolFlags(points, i, i + 1));
    // The end dot as its own disc, drawn last: the last capsule fades from
    // the line's colour to the tip's, which left a growing blot pool half
    // line-coloured (a "D" instead of a pool).
    const tail = points[n - 1]!;
    writeOne(n - 1, tail, tail, poolFlags(points, n - 1, n - 1));
    return n;
  };

  const boxOf = (points: readonly SpineDot[], from: number): StrokeAabb => {
    const box = emptyAabb();
    for (let i = from; i < points.length; i++) {
      const p = points[i]!;
      expandAabb(box, { ...p, r: p.r * 2 });
    }
    return box;
  };

  /** Grow `r` left/up to an even origin (fwidth works on 2x2 quads, as replay does). */
  const even = (r: PixelRect, w: number, h: number): PixelRect => {
    const x = r.x & ~1, y = r.y & ~1;
    return { x, y, w: Math.min(w - x, r.w + r.x - x), h: Math.min(h - y, r.h + r.y - y) };
  };
  const rectFor = (box: StrokeAabb, w: number, h: number): PixelRect | null => {
    const clip = clipBlitRect(box, w, h, CLIP_BLIT_PAD);
    return clip ? even(clip, w, h) : null;
  };

  /**
   * Copy the surface's top-left `w` x `h` to `dest` at (dx, dy). An
   * OffscreenCanvas surface hands its frame over without a copy; the surface
   * is not preserved, so it is drawn from scratch before each blit anyway.
   */
  const blit = (dest: CanvasRenderingContext2D, sx: number, sy: number, w: number, h: number, dx: number, dy: number) => {
    const surface = sdf.canvas as unknown as Partial<OffscreenCanvas>;
    if (typeof surface.transferToImageBitmap === "function") {
      const frame = surface.transferToImageBitmap();
      dest.drawImage(frame, sx, sy, w, h, dx, dy, w, h);
      (frame as Partial<ImageBitmap>).close?.();
      return;
    }
    dest.drawImage(sdf.canvas, sx, sy, w, h, dx, dy, w, h);
  };

  /** Render every capsule that reaches host `rect` into the surface's top-left. */
  const renderRect = (rect: PixelRect, count: number) => {
    // Grow only: a frame's box is small, and reallocating per frame churns.
    if (sdf.canvas.width < rect.w || sdf.canvas.height < rect.h) {
      sdf.resize(Math.max(rect.w, sdf.canvas.width), Math.max(rect.h, sdf.canvas.height));
    }
    sdf.setOrigin(rect.x, rect.y);
    const box = { minX: rect.x, minY: rect.y, maxX: rect.x + rect.w, maxY: rect.y + rect.h };
    sdf.erase({ minX: rect.x, minY: rect.y, maxX: rect.x + sdf.canvas.width, maxY: rect.y + sdf.canvas.height });
    sdf.redrawRanges(box, touching(box, count));
  };

  /**
   * Render host rect `r` (even origin) chunk by chunk and blit the part of
   * each chunk inside `t` to the same place on `dest`.
   */
  const renderBlit = (dest: CanvasRenderingContext2D, r: PixelRect, t: PixelRect, count: number) => {
    for (let cy = r.y; cy < r.y + r.h; cy += LIVE_CHUNK_PX) {
      for (let cx = r.x; cx < r.x + r.w; cx += LIVE_CHUNK_PX) {
        const c = {
          x: cx, y: cy,
          w: Math.min(LIVE_CHUNK_PX, r.x + r.w - cx),
          h: Math.min(LIVE_CHUNK_PX, r.y + r.h - cy),
        };
        const x0 = Math.max(c.x, t.x), y0 = Math.max(c.y, t.y);
        const x1 = Math.min(c.x + c.w, t.x + t.w), y1 = Math.min(c.y + c.h, t.y + t.h);
        if (x1 <= x0 || y1 <= y0) continue;
        renderRect(c, count);
        blit(dest, x0 - c.x, y0 - c.y, x1 - x0, y1 - y0, x0, y0);
      }
    }
  };

  const clear = () => {
    frozen = 0;
    previous = null;
    stale = true;
  };

  return {
    clear,
    paint(host: HTMLCanvasElement, snap: HTMLCanvasElement | null,
      points: readonly SpineDot[], stableTo: number): StrokeAabb {
      const ctx = host.getContext("2d")!;
      if (points.length === 0) return emptyAabb();
      if (stale) {
        frozen = 0;
        previous = null;
      }
      // Smoothed colours read ahead along the stroke, so keep that much live.
      const next = Math.max(frozen, smoothStableTo(points, Math.min(stableTo, points.length - 1)));
      const count = write(points, stale ? 0 : frozen);
      // Old tail plus the hops rewritten this frame, never the stroke box.
      const dirty = boxOf(points, stale ? 0 : frozen);
      if (previous) {
        dirty.minX = Math.min(dirty.minX, previous.minX);
        dirty.minY = Math.min(dirty.minY, previous.minY);
        dirty.maxX = Math.max(dirty.maxX, previous.maxX);
        dirty.maxY = Math.max(dirty.maxY, previous.maxY);
      }
      sdf.uploadTail(inst, stale ? 0 : frozen, count);
      stale = false;
      frozen = next;
      previous = boxOf(points, frozen);
      const rect = rectFor(dirty, host.width, host.height);
      if (!rect) return dirty;
      // A returning tail can cross the frozen prefix inside this box, so
      // every capsule that reaches it is redrawn, not only the tail's.
      const { x, y, w, h } = rect;
      ctx.clearRect(x, y, w, h);
      if (snap) ctx.drawImage(snap, x, y, w, h, x, y, w, h);
      renderBlit(ctx, rect, rect, count);
      return dirty;
    },
    /**
     * Draw a whole idle stroke onto `dest` (the committed snap). `dests` limits
     * the blit to camera-shift strips; empty means the stroke's own box.
     */
    paintStroke(dest: CanvasRenderingContext2D, points: readonly SpineDot[],
      tip: SpineDot | null, box: StrokeAabb, dests: readonly PixelRect[]) {
      if (points.length === 0) return;
      let count = write(points, 0);
      const last = points[points.length - 1]!;
      // A held blot can grow the tip past the last spine dot.
      if (tip && (tip.r > last.r + 1e-3 || tip.x !== last.x || tip.y !== last.y)) {
        ensure(count + 1);
        // The held tip is the pool the stroke ends in.
        writeOne(count, tip, tip, (tip.pool ?? 0) > 1e-3 ? 3 : 0);
        count += 1;
      }
      sdf.upload(inst, count);
      const { width, height } = dest.canvas;
      const own = rectFor(box, width, height);
      const targets = dests.length > 0 ? dests : own ? [own] : [];
      dest.save();
      dest.setTransform(1, 0, 0, 1, 0, 0);
      for (const target of targets) {
        // Render from an even origin, but blit only the requested strip.
        renderBlit(dest, even(target, width, height), target, count);
      }
      dest.restore();
      // The instance buffer now holds this stroke, not a live one.
      clear();
    },
    isLost(): boolean {
      return sdf.isLost();
    },
    destroy() {
      sdf.destroy();
    },
  };
}
