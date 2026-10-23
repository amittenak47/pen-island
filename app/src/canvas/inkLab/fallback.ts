/**
 * Canvas 2D mitered strip. Shared vertices. Round caps only at the true head
 * and tail. One tip disc while held. No arc() at interior joins.
 */

import { smoothSpineRgb } from "./inkSmooth";
import type { SpineDot } from "./instance";

export type FallbackPainter = {
  canvas: HTMLCanvasElement;
  resize(w: number, h: number): void;
  beginStroke(): void;
  appendHop(a: SpineDot, b: SpineDot, rgb: readonly [number, number, number]): void;
  clearLive(): void;
  blit(ctx: CanvasRenderingContext2D): void;
  destroy(): void;
};

function fillQuad(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): void {
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineTo(cx, cy);
  ctx.lineTo(dx, dy);
  ctx.closePath();
  ctx.fill();
}

export function createFallbackPainter(
  peer: (w: number, h: number) => HTMLCanvasElement | null,
  w: number,
  h: number,
): FallbackPainter | null {
  const canvas = peer(Math.max(1, w), Math.max(1, h));
  if (!canvas) return null;
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  let cappedHead = false;

  const resize = (nw: number, nh: number) => {
    const width = Math.max(1, nw);
    const height = Math.max(1, nh);
    if (canvas.width === width && canvas.height === height) return;
    const prev = peer(canvas.width, canvas.height);
    if (prev) {
      prev.width = canvas.width;
      prev.height = canvas.height;
      const pctx = prev.getContext("2d");
      pctx?.drawImage(canvas, 0, 0);
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(prev, 0, 0);
    } else {
      canvas.width = width;
      canvas.height = height;
    }
  };

  return {
    canvas,
    resize,
    beginStroke() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      cappedHead = false;
    },
    appendHop(a, b, rgb) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
      if (len < 1e-4) {
        if (!cappedHead) {
          ctx.beginPath();
          ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
          ctx.fill();
          cappedHead = true;
        }
        return;
      }
      const nx = -dy / len;
      const ny = dx / len;
      fillQuad(
        ctx,
        a.x + nx * a.r,
        a.y + ny * a.r,
        b.x + nx * b.r,
        b.y + ny * b.r,
        b.x - nx * b.r,
        b.y - ny * b.r,
        a.x - nx * a.r,
        a.y - ny * a.r,
      );
      if (!cappedHead) {
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
        ctx.fill();
        cappedHead = true;
      }
    },
    clearLive() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      cappedHead = false;
    },
    blit(target) {
      target.drawImage(canvas, 0, 0);
    },
    destroy() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

export type MiterStrokeOpts = {
  capHead?: boolean;
  capEnd?: boolean;
  from?: number;
  to?: number;
  /** Several point spans, flat inclusive `[from, to]` pairs, filled together. */
  ranges?: readonly number[];
};

type Span = readonly [number, number];

function spansOf(spine: readonly SpineDot[], opts?: MiterStrokeOpts): Span[] {
  const last = spine.length - 1;
  const out: Span[] = [];
  const add = (f: number, t: number) => {
    const from = Math.max(0, f), to = Math.min(last, t);
    if (to >= from) out.push([from, to]);
  };
  if (opts?.ranges) {
    for (let k = 0; k + 1 < opts.ranges.length; k += 2) add(opts.ranges[k]!, opts.ranges[k + 1]!);
  } else {
    add(opts?.from ?? 0, opts?.to ?? last);
  }
  return out;
}

/**
 * Shared, bounded miter vertex offset at dot `i`. Neighbours outside a
 * requested span still count, so spans drawn in different frames agree.
 */
function miterEdge(spine: readonly SpineDot[], i: number): [number, number] {
  const p = spine[i]!;
  const before = spine[Math.max(0, i - 1)]!;
  const after = spine[Math.min(spine.length - 1, i + 1)]!;
  const ax = p.x - before.x, ay = p.y - before.y;
  const bx = after.x - p.x, by = after.y - p.y;
  const al = Math.hypot(ax, ay), bl = Math.hypot(bx, by);
  const nx = bl > 1e-4 ? -by / bl : al > 1e-4 ? -ay / al : 0;
  const ny = bl > 1e-4 ? bx / bl : al > 1e-4 ? ax / al : 1;
  if (al < 1e-4 || bl < 1e-4) return [nx * p.r, ny * p.r];
  const mx = -ay / al + nx, my = ax / al + ny;
  const ml = Math.hypot(mx, my);
  if (ml < 1e-4) return [nx * p.r, ny * p.r];
  const ux = mx / ml, uy = my / ml;
  const radius = Math.min(p.r * 2, p.r / Math.max(0.5, ux * nx + uy * ny));
  return [ux * radius, uy * radius];
}

/** Unit normal of the nearest non-zero hop from dot `i`, walking `step` (+1 or -1). */
function hopNormal(spine: readonly SpineDot[], i: number, step: 1 | -1): [number, number] | null {
  const p = spine[i]!;
  for (let k = i + step; k >= 0 && k < spine.length; k += step) {
    const q = spine[k]!;
    const dx = step > 0 ? q.x - p.x : p.x - q.x, dy = step > 0 ? q.y - p.y : p.y - q.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-4) return [-dy / len, dx / len];
  }
  return null;
}

/**
 * A turn sharper than this splits the strip at the dot. There the miter
 * vertex is clamped and can point almost along the stroke, twisting a quad
 * into a backwards bow-tie whose zero winding cut holes in the edges where
 * the pen doubles back. Each side ends on its own normal and a disc rounds
 * the turn.
 */
const SHARP_TURN_COS = -0.3;

function sharpJoint(spine: readonly SpineDot[], i: number): boolean {
  if (i <= 0 || i >= spine.length - 1) return false;
  const n1 = hopNormal(spine, i, -1), n2 = hopNormal(spine, i, 1);
  return !!n1 && !!n2 && n1[0] * n2[0] + n1[1] * n2[1] < SHARP_TURN_COS;
}

function circle(ctx: CanvasRenderingContext2D, p: SpineDot): void {
  ctx.moveTo(p.x + p.r, p.y);
  // Same winding as the strip, so a cap overlaps rather than cuts it out.
  ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2, true);
  ctx.closePath();
}

/** Add the whole outline (quads, then the true end caps) to the current path. */
function outline(
  ctx: CanvasRenderingContext2D,
  spine: readonly SpineDot[],
  tip: SpineDot | null,
  spans: readonly Span[],
  capHead: boolean,
  capEnd: boolean,
): void {
  const discs = new Set<number>();
  for (const [from, to] of spans) {
    for (let i = from; i < to; i++) {
      const a = spine[i]!, b = spine[i + 1]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-4) continue;
      const nx = a.y - b.y, ny = b.x - a.x;
      const own = (p: SpineDot): [number, number] => [nx / len * p.r, ny / len * p.r];
      let [ax, ay] = sharpJoint(spine, i) ? own(a) : miterEdge(spine, i);
      let [bx, by] = sharpJoint(spine, i + 1) ? own(b) : miterEdge(spine, i + 1);
      // Where the curve is tighter than the nib, neighbouring miter vertices
      // cross and an edge of this quad runs backwards: zero winding again.
      // Such a quad stands on its own normal, and discs close its ends.
      const hx = b.x - a.x, hy = b.y - a.y;
      const flipA = ax * nx + ay * ny < 0 ? -1 : 1, flipB = bx * nx + by * ny < 0 ? -1 : 1;
      const e1 = (hx + bx * flipB - ax * flipA) * hx + (hy + by * flipB - ay * flipA) * hy;
      const e2 = (hx - bx * flipB + ax * flipA) * hx + (hy - by * flipB + ay * flipA) * hy;
      if (e1 <= 0 || e2 <= 0) {
        [ax, ay] = own(a);
        [bx, by] = own(b);
        discs.add(i);
        discs.add(i + 1);
      }
      // A retrace reverses the geometric normal. Orient both ends to this
      // hop, otherwise the quad becomes a bow-tie with a transparent centre.
      if (ax * nx + ay * ny < 0) { ax = -ax; ay = -ay; }
      if (bx * nx + by * ny < 0) { bx = -bx; by = -by; }
      ctx.moveTo(a.x + ax, a.y + ay);
      ctx.lineTo(b.x + bx, b.y + by);
      ctx.lineTo(b.x - bx, b.y - by);
      ctx.lineTo(a.x - ax, a.y - ay);
      ctx.closePath();
    }
  }
  for (const [from, to] of spans) {
    for (let i = Math.max(1, from); i <= Math.min(spine.length - 2, to); i++) {
      if (sharpJoint(spine, i) || discs.has(i)) circle(ctx, spine[i]!);
    }
  }
  const head = spine[0];
  const tail = tip ?? spine[spine.length - 1];
  if (head && capHead) circle(ctx, head);
  if (tail && capEnd) {
    if (!head || !capHead || Math.hypot(tail.x - head.x, tail.y - head.y) > 1e-4 ||
        Math.abs(tail.r - head.r) > 1e-4) circle(ctx, tail);
  }
}

const cssRgb = (c: readonly [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const COLOUR_STEP = 4;
const colourKey = (c: readonly [number, number, number]) =>
  `${Math.round(c[0] / COLOUR_STEP)},${Math.round(c[1] / COLOUR_STEP)},${Math.round(c[2] / COLOUR_STEP)}`;

/** Grow-only scratch for the colour layer. Null where no canvas can be made. */
let scratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null | undefined;
const SCRATCH_MAX_PX = 4096;

function scratchFor(like: CanvasRenderingContext2D, w: number, h: number) {
  if (w > SCRATCH_MAX_PX || h > SCRATCH_MAX_PX) return null;
  if (scratch === undefined) {
    let canvas: HTMLCanvasElement | null = null;
    const g = globalThis as { OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas };
    try {
      if (typeof g.OffscreenCanvas === "function") {
        canvas = new g.OffscreenCanvas(w, h) as unknown as HTMLCanvasElement;
      } else if (typeof document !== "undefined" && typeof document.createElement === "function") {
        canvas = document.createElement("canvas");
      } else {
        // Tests and other hosts: a canvas of the destination's own kind.
        const Ctor = (like.canvas as unknown as { constructor?: new (w: number, h: number) => HTMLCanvasElement })
          ?.constructor;
        canvas = Ctor ? new Ctor(w, h) : null;
      }
    } catch {
      canvas = null;
    }
    const ctx = canvas?.getContext("2d") as CanvasRenderingContext2D | null | undefined;
    scratch = canvas && ctx ? { canvas, ctx } : null;
  }
  if (!scratch) return null;
  if (scratch.canvas.width < w || scratch.canvas.height < h) {
    scratch.canvas.width = Math.max(w, scratch.canvas.width);
    scratch.canvas.height = Math.max(h, scratch.canvas.height);
  }
  return scratch;
}

/**
 * One antialiased edge for a stroke whose colour changes along it: paint the
 * colours on a scratch canvas as overlapping wide segments (no gaps between
 * them, so no seams), cut them to the outline in one fill, and blit once.
 * False when the context has no transform or no scratch canvas can be made.
 */
function fillLayered(
  ctx: CanvasRenderingContext2D,
  spine: readonly SpineDot[],
  tip: SpineDot | null,
  rgb: readonly [number, number, number],
  spans: readonly Span[],
  capHead: boolean,
  capEnd: boolean,
  alpha: number,
): boolean {
  if (typeof ctx.getTransform !== "function") return false;
  let t: DOMMatrix | undefined;
  try {
    t = ctx.getTransform();
  } catch {
    return false;
  }
  if (!t || ![t.a, t.b, t.c, t.d, t.e, t.f].every(Number.isFinite)) return false;
  const scale = Math.hypot(t.a, t.b) || 1;
  // Work in device pixels: map only the dots the spans reach (with the
  // neighbours their miters read, and the true ends) through the transform.
  const map = (d: SpineDot): SpineDot => ({
    ...d,
    x: t!.a * d.x + t!.c * d.y + t!.e,
    y: t!.b * d.x + t!.d * d.y + t!.f,
    r: d.r * scale,
  });
  const last = spine.length - 1;
  const dev: SpineDot[] = new Array(spine.length);
  const need = (i: number) => {
    if (i >= 0 && i <= last && dev[i] === undefined) dev[i] = map(spine[i]!);
  };
  need(0);
  need(last);
  for (const [from, to] of spans) for (let i = from - 1; i <= to + 1; i++) need(i);
  const devTip = tip ? map(tip) : null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (p: SpineDot) => {
    const r = p.r * 2 + 2;
    x0 = Math.min(x0, p.x - r); y0 = Math.min(y0, p.y - r);
    x1 = Math.max(x1, p.x + r); y1 = Math.max(y1, p.y + r);
  };
  for (const [from, to] of spans) for (let i = from; i <= to; i++) grow(dev[i]!);
  if (devTip && capEnd) grow(devTip);
  if (!Number.isFinite(x0)) return true;
  const dw = Math.max(1, ctx.canvas?.width ?? Math.ceil(x1));
  const dh = Math.max(1, ctx.canvas?.height ?? Math.ceil(y1));
  const bx = Math.max(0, Math.floor(x0)), by = Math.max(0, Math.floor(y0));
  const w = Math.min(dw, Math.ceil(x1)) - bx, h = Math.min(dh, Math.ceil(y1)) - by;
  if (w < 1 || h < 1) return true;
  const pad = scratchFor(ctx, w, h);
  if (!pad) return false;
  // Scratch-local pixels, identity transform: some canvas backends (napi
  // Skia in tests) drop a destination-in fill drawn under any transform.
  for (const d of dev) if (d) { d.x -= bx; d.y -= by; }
  if (devTip) { devTip.x -= bx; devTip.y -= by; }
  const s = pad.ctx;
  s.setTransform(1, 0, 0, 1, 0, 0);
  s.globalCompositeOperation = "source-over";
  s.globalAlpha = 1;
  s.clearRect(0, 0, w, h);
  s.lineCap = "round";
  // Twice the radius covers a miter vertex (at most 2r out) at every joint.
  for (const [from, to] of spans) {
    if (from === to) {
      const p = dev[from]!;
      s.fillStyle = cssRgb(p.rgb ?? rgb);
      s.beginPath();
      s.arc(p.x, p.y, p.r * 2, 0, Math.PI * 2);
      s.fill();
      continue;
    }
    // One polyline per run of hops whose colour rounds the same: a stroke
    // per hop was most of a frame. Steps of COLOUR_STEP levels do not show.
    let i = from;
    while (i < to) {
      const key = colourKey(dev[i]!.rgb ?? rgb);
      let j = i + 1;
      let r = Math.max(dev[i]!.r, dev[j]!.r);
      while (j < to && colourKey(dev[j]!.rgb ?? rgb) === key) {
        r = Math.max(r, dev[j + 1]!.r);
        j++;
      }
      s.strokeStyle = cssRgb(dev[i]!.rgb ?? rgb);
      s.lineWidth = r * 4;
      s.lineJoin = "round";
      s.beginPath();
      s.moveTo(dev[i]!.x, dev[i]!.y);
      for (let k = i + 1; k <= j; k++) s.lineTo(dev[k]!.x, dev[k]!.y);
      s.stroke();
      i = j;
    }
  }
  const end = dev[last];
  // The end cap in the tip's own colour, so a blot pool is whole (as WebGL).
  const capDot = devTip && capEnd ? devTip : capEnd ? end : null;
  if (capDot && spans.some(([, t]) => t === last)) {
    s.fillStyle = cssRgb(capDot.rgb ?? rgb);
    s.beginPath();
    s.arc(capDot.x, capDot.y, capDot.r + 0.5, 0, Math.PI * 2);
    s.fill();
  }
  if (devTip && capEnd && end && tip !== spine[last]) {
    s.strokeStyle = cssRgb(devTip.rgb ?? rgb);
    s.lineWidth = Math.max(devTip.r, end.r) * 4;
    s.beginPath();
    s.moveTo(end.x, end.y);
    s.lineTo(devTip.x, devTip.y);
    s.stroke();
  }
  s.globalCompositeOperation = "destination-in";
  s.fillStyle = "#000";
  s.beginPath();
  outline(s, dev, devTip, spans, capHead, capEnd);
  s.fill();
  s.globalCompositeOperation = "source-over";
  s.setTransform(1, 0, 0, 1, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alpha;
  // Hand an OffscreenCanvas's frame over instead of reading a canvas drawn
  // this frame (a copy and a sync stall). The scratch is cleared per use.
  const offscreen = pad.canvas as unknown as Partial<OffscreenCanvas>;
  if (typeof offscreen.transferToImageBitmap === "function") {
    const frame = offscreen.transferToImageBitmap();
    ctx.drawImage(frame, 0, 0, w, h, bx, by, w, h);
    (frame as Partial<ImageBitmap>).close?.();
  } else {
    ctx.drawImage(pad.canvas, 0, 0, w, h, bx, by, w, h);
  }
  ctx.restore();
  return true;
}

/** One fill per run of equal colour: the old behaviour, last resort only. */
function fillPerColour(
  ctx: CanvasRenderingContext2D,
  spine: readonly SpineDot[],
  tip: SpineDot | null,
  rgb: readonly [number, number, number],
  spans: readonly Span[],
  capHead: boolean,
  capEnd: boolean,
): void {
  let style = "";
  let alpha = -1;
  let pending = false;
  const use = (p: SpineDot) => {
    const next = cssRgb(p.rgb ?? rgb);
    const a = p.a ?? 1;
    if (next !== style || a !== alpha) {
      if (pending) ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = style = next;
      ctx.globalAlpha = alpha = a;
      pending = false;
    }
    pending = true;
  };
  for (const span of spans) {
    for (let k = span[0]; k < span[1]; k++) {
      use(spine[k]!);
      outline(ctx, spine, null, [[k, k + 1]], false, false);
    }
  }
  const head = spine[0];
  const tail = tip ?? spine[spine.length - 1];
  if (head && capHead) {
    use(head);
    circle(ctx, head);
  }
  if (tail && capEnd && (!head || !capHead || Math.hypot(tail.x - head.x, tail.y - head.y) > 1e-4 ||
      Math.abs(tail.r - head.r) > 1e-4)) {
    use(tail);
    circle(ctx, tail);
  }
  if (pending) ctx.fill();
  ctx.globalAlpha = 1;
}

/**
 * Canvas 2D strip for a stroke, or some spans of one. The whole requested
 * geometry is one outline with one antialiased edge: no seam where two quads
 * or two spans meet, and caps no darker than the body.
 */
export function fillMiterStroke(
  ctx: CanvasRenderingContext2D,
  spine: readonly SpineDot[],
  tip: SpineDot | null,
  rgb: readonly [number, number, number],
  opts?: MiterStrokeOpts,
): void {
  const spans = spansOf(spine, opts);
  if (spans.length === 0) return;
  // Smooth colours along the stroke as WebGL does (see ./inkSmooth.ts), from
  // the first dot a span or its miter neighbour reads.
  let first = spine.length;
  for (const [from] of spans) first = Math.min(first, from);
  const raw = spine;
  spine = smoothSpineRgb(raw, Math.max(0, first - 1));
  if (tip === raw[raw.length - 1]) tip = spine[spine.length - 1]!;
  const last = spine.length - 1;
  const capHead = opts?.capHead !== false && spans.some(([f]) => f === 0);
  const capEnd = opts?.capEnd !== false && spans.some(([, t]) => t === last);
  let style: string | null = null;
  let alpha = 1;
  let uniform = true;
  let sameAlpha = true;
  const see = (p: SpineDot) => {
    const c = cssRgb(p.rgb ?? rgb), a = p.a ?? 1;
    if (style === null) {
      style = c;
      alpha = a;
      return;
    }
    if (c !== style) uniform = false;
    if (a !== alpha) uniform = sameAlpha = false;
  };
  for (const [from, to] of spans) for (let i = from; i <= to; i++) see(spine[i]!);
  if (tip && capEnd) see(tip);
  if (uniform) {
    ctx.fillStyle = style!;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    outline(ctx, spine, tip, spans, capHead, capEnd);
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }
  // Colour varies (pressure deposit, wash). A fill per colour was the seam:
  // neighbouring quads each antialiased their shared edge.
  if (sameAlpha && fillLayered(ctx, spine, tip, rgb, spans, capHead, capEnd, alpha)) return;
  fillPerColour(ctx, spine, tip, rgb, spans, capHead, capEnd);
}
