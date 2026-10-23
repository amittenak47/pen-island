import { clipBlitRect, CLIP_BLIT_PAD, type PixelRect } from "./clipBlit";
import {
  emptyAabb,
  expandAabb,
  INSTANCE_FLOATS,
  writeInstance,
  type SpineDot,
  type StrokeAabb,
} from "./instance";
import type { SdfRenderer } from "./sdf";
import { INK_RGB } from "./style";

function inkOf(d: SpineDot): readonly [number, number, number] {
  return d.rgb ?? INK_RGB;
}

/**
 * Live WebGL2 capsules with the same contract as {@link createLiveRibbon}.
 * The GL surface keeps the whole stroke; each paint rewrites the hops past the
 * frozen prefix, erases and redraws only the moving tail box, and presents
 * that box. One instanced draw and one blit per frame, never one per hop.
 */
export function createLiveSdf(sdf: SdfRenderer) {
  let inst = new Float32Array(32 * INSTANCE_FLOATS);
  let frozen = 0;
  let previous: StrokeAabb | null = null;
  /** GL pixels do not hold this stroke (new stroke, resize, snap blit). */
  let stale = true;

  const ensure = (n: number) => {
    if (n * INSTANCE_FLOATS <= inst.length) return;
    let cap = inst.length / INSTANCE_FLOATS;
    while (cap < n) cap *= 2;
    const next = new Float32Array(cap * INSTANCE_FLOATS);
    next.set(inst);
    inst = next;
  };

  /** Hops `[from, n-1)`, or one round dot for a lone sample. Returns instance count. */
  const write = (points: readonly SpineDot[], from: number): number => {
    const n = points.length;
    if (n === 1) {
      ensure(1);
      const p = points[0]!;
      writeInstance(inst, 0, p, p, inkOf(p), inkOf(p));
      return 1;
    }
    ensure(n - 1);
    for (let i = from; i < n - 1; i++) {
      const a = points[i]!, b = points[i + 1]!;
      writeInstance(inst, i, a, b, inkOf(a), inkOf(b));
    }
    return n - 1;
  };

  const boxOf = (points: readonly SpineDot[], from: number): StrokeAabb => {
    const box = emptyAabb();
    for (let i = from; i < points.length; i++) {
      const p = points[i]!;
      expandAabb(box, { ...p, r: p.r * 2 });
    }
    return box;
  };

  const fit = (w: number, h: number) => {
    if (sdf.canvas.width === w && sdf.canvas.height === h) return;
    sdf.resize(w, h);
    stale = true;
  };

  const clear = () => {
    sdf.clear();
    frozen = 0;
    previous = null;
    stale = true;
  };

  return {
    clear,
    paint(host: HTMLCanvasElement, snap: HTMLCanvasElement | null,
      points: readonly SpineDot[], stableTo: number): StrokeAabb {
      const ctx = host.getContext("2d")!;
      fit(host.width, host.height);
      if (points.length === 0) return emptyAabb();
      if (stale) {
        sdf.clear();
        frozen = 0;
        previous = null;
      }
      const next = Math.max(frozen, Math.min(stableTo, points.length - 1));
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
      sdf.erase(dirty);
      // A returning tail can cross the frozen prefix inside this box.
      sdf.redraw(dirty, 0);
      stale = false;
      frozen = next;
      previous = boxOf(points, frozen);
      const clip = clipBlitRect(dirty, host.width, host.height, CLIP_BLIT_PAD);
      if (!clip) return dirty;
      const { x, y, w, h } = clip;
      ctx.clearRect(x, y, w, h);
      if (snap) ctx.drawImage(snap, x, y, w, h, x, y, w, h);
      ctx.drawImage(sdf.canvas, x, y, w, h, x, y, w, h);
      return dirty;
    },
    /**
     * Draw a whole idle stroke onto `dest` (the committed snap). `dests` limits
     * the blit to camera-shift strips; empty means the stroke's own box.
     */
    paintStroke(dest: CanvasRenderingContext2D, points: readonly SpineDot[],
      tip: SpineDot | null, box: StrokeAabb, dests: readonly PixelRect[]) {
      if (points.length === 0) return;
      fit(dest.canvas.width, dest.canvas.height);
      let count = write(points, 0);
      const last = points[points.length - 1]!;
      // A held blot can grow the tip past the last spine dot.
      if (tip && (tip.r > last.r + 1e-3 || tip.x !== last.x || tip.y !== last.y)) {
        ensure(count + 1);
        writeInstance(inst, count, tip, tip, inkOf(tip), inkOf(tip));
        count += 1;
      }
      sdf.clear();
      sdf.upload(inst, count);
      const rects = dests.length > 0
        ? dests
        : [clipBlitRect(box, dest.canvas.width, dest.canvas.height, CLIP_BLIT_PAD)].filter(
          (r): r is PixelRect => r != null);
      const drawBox = emptyAabb();
      for (const r of rects) {
        drawBox.minX = Math.min(drawBox.minX, r.x);
        drawBox.minY = Math.min(drawBox.minY, r.y);
        drawBox.maxX = Math.max(drawBox.maxX, r.x + r.w);
        drawBox.maxY = Math.max(drawBox.maxY, r.y + r.h);
      }
      if (rects.length > 0) sdf.draw(drawBox);
      dest.save();
      dest.setTransform(1, 0, 0, 1, 0, 0);
      for (const r of rects) dest.drawImage(sdf.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      dest.restore();
      // The GL surface now holds this stroke, not a live one.
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
