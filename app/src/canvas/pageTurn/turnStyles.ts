/**
 * Page turn styles: Paperback and Hardcover.
 *
 * Pure drawing, one frame at a time, so the same code runs in the page turn
 * and in the lab page where the styles are judged (a bundle of this file). It
 * draws in page units with the spine at x = 0: the turning page spans
 * 0..width, and in a spread the left page spans -width..0.
 *
 * - Paperback: the pinch and fold, with the crease as a narrow rolled band.
 *   Each row of the page lies flat up to the roll, goes round it (print
 *   squeezed, lit on top, dark underneath), and comes back over itself as
 *   the flap. The roll tightens with tension, a corner hold or a fast pull,
 *   and the fold bows toward the hand.
 * - Hardcover: a stiff page hinged at the spine, with a small curl where it
 *   leaves the binding, turning as one piece with a little perspective.
 *
 * The back of the page carries its own print in a spread (the next left page)
 * and, in both layouts, the front showing through faintly. On dark paper the
 * depth comes from light, not shadow: black shadows vanish on a black page.
 */

export type TurnStyle = "paperback" | "hardcover";

export interface TurnStyleImages {
  /** The page being turned. */
  front: CanvasImageSource;
  /** What lies under it on its side of the spine. */
  under: CanvasImageSource | null;
  /** A spread's left page, which the turning page comes over. */
  left?: CanvasImageSource | null;
  /** The print on the back of the turning page: a spread's next left page. */
  back?: CanvasImageSource | null;
  /** `front` mirrored left to right, for the print showing through from behind. */
  frontMirrored?: CanvasImageSource | null;
}

export interface TurnStyleFrame {
  style: TurnStyle;
  spread: boolean;
  /** One page, in drawing units. */
  width: number;
  height: number;
  /** Image pixels per drawing unit. */
  imageScale: number;
  /** 0 resting, 1 turned over. */
  pull: number;
  /** Where the page is held: 0 the top corner, 1 the bottom corner. */
  grip: number;
  /** 0 slack (a loose roll), 1 tight. */
  tension: number;
  /** How fast the hand is moving, px per ms: a fast pull rolls tighter. */
  speed: number;
  dark: boolean;
  paper: string;
  images: TurnStyleImages;
  /** Print on the back (a spread's next left page). */
  showBack: boolean;
  /** The front's print faintly through the back. */
  showThrough: boolean;
  /** The shadow (or on dark paper the glow) under the roll or the page. */
  shadow: boolean;
}

export interface TurnStyleInfo {
  radius?: number;
  bow?: number;
  angle?: number;
}

/** Faint front print through the back: stronger on a blank back than on printed one. */
const THROUGH_ON_BLANK = 0.22;
const THROUGH_ON_PRINT = 0.12;
/** Rows a Paperback sheet is drawn in, in drawing units. */
const ROW = 2;
/** Strips across the roll, each way round. */
const ROLL_STEPS = 10;

/** The roll's radius: smaller (tighter) with tension, a corner hold, or speed. */
export function rollRadius(f: Pick<TurnStyleFrame, "width" | "grip" | "tension" | "speed">): number {
  const side = 1 - Math.abs(f.grip - 0.5) * 2; // 1 held mid-side, 0 at a corner
  const base = (3.5 + 20 * (1 - f.tension)) * (f.width / 380);
  return Math.max(2, (base * (0.62 + 0.38 * side)) / (1 + f.speed * 0.9));
}

export interface RowFold {
  /** How far the sheet lies flat from the spine. */
  flat: number;
  /** How far round the roll the sheet goes, in radians (π: all the way). */
  turned: number;
  /** All the way round, with a flap lying back over the page. */
  over: boolean;
}

/**
 * The fold of one row whose free edge is at `edge`, for a page `width` wide
 * rolled at radius `r`: flat to `flat`, round the roll, back over itself.
 * Null while the row still lies flat.
 */
export function rowFold(edge: number, width: number, r: number): RowFold | null {
  if (edge >= width - 0.5) return null;
  const flat = (edge + width - Math.PI * r) / 2;
  if (width - flat >= Math.PI * r) return { flat, turned: Math.PI, over: true };
  // Early in the peel the edge has not come all the way round the roll.
  let lo = Math.max(0, width - Math.PI * r), hi = width;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    const x = mid + r * Math.sin((width - mid) / r);
    if (x > edge) hi = mid; else lo = mid;
  }
  const at = (lo + hi) / 2;
  return { flat: at, turned: (width - at) / r, over: false };
}

/** Where a row's free edge is: furthest out where the page is held, bowing back from there. */
export function rowEdge(f: Pick<TurnStyleFrame, "width" | "height" | "pull" | "grip" | "tension">, y: number): number {
  const held = f.width - f.pull * 2 * f.width;
  const pulled = f.width - held;
  const bow = Math.min(pulled, pulled * (0.22 + 0.3 * (1 - f.tension)));
  const d = (y - f.grip * f.height) / (f.height * 0.55);
  return Math.min(f.width, held + bow * (1 - Math.exp(-d * d)));
}

function drawStill(ctx: CanvasRenderingContext2D, f: TurnStyleFrame): void {
  const { width: P, height: H, images } = f;
  if (images.under) ctx.drawImage(images.under, 0, 0, P * f.imageScale, H * f.imageScale, 0, 0, P, H);
  if (f.spread && images.left) ctx.drawImage(images.left, 0, 0, P * f.imageScale, H * f.imageScale, -P, 0, P, H);
}

/**
 * Sheet points s0..s1 (s0 < s1), seen from behind, laid at x1..x0 (x1 < x0)
 * in rows y0..y0+h: the back's own print, or paper, and the front through it.
 */
function drawBack(
  ctx: CanvasRenderingContext2D, f: TurnStyleFrame,
  s0: number, s1: number, x0: number, x1: number, y0: number, h: number, sy: number, sh: number,
): void {
  const dx = x0 - x1;
  if (dx < 0.05) return;
  const K = f.imageScale, P = f.width;
  const back = f.showBack ? f.images.back ?? null : null;
  if (back) ctx.drawImage(back, (P - s1) * K, sy, (s1 - s0) * K, sh, x1, y0, dx, h);
  else { ctx.fillStyle = f.paper; ctx.fillRect(x1, y0, dx, h); }
  const through = f.showThrough ? f.images.frontMirrored ?? null : null;
  if (through) {
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * (back ? THROUGH_ON_PRINT : THROUGH_ON_BLANK);
    ctx.drawImage(through, (P - s1) * K, sy, (s1 - s0) * K, sh, x1, y0, dx, h);
    ctx.globalAlpha = alpha;
  }
}

/** Paperback: see the file comment. */
export function paintPaperback(ctx: CanvasRenderingContext2D, f: TurnStyleFrame): TurnStyleInfo {
  const { width: P, height: H, imageScale: K, dark } = f;
  const r = rollRadius(f);
  const front = f.images.front;
  drawStill(ctx, f);
  const rows = Math.ceil(H / ROW);
  for (let i = 0; i < rows; i++) {
    const y0 = i * ROW, h = Math.min(H, y0 + ROW) - y0;
    const sy = y0 * K, sh = h * K;
    const edge = rowEdge(f, y0 + h / 2);
    const fold = rowFold(edge, P, r);
    if (!fold) {
      ctx.drawImage(front, 0, sy, P * K, sh, 0, y0, P, h);
      continue;
    }
    const { flat, turned, over } = fold;

    // Under the roll: a shadow on light paper, a faint glow on dark, widest under the curve.
    if (f.shadow) {
      const span = r * 1.2 + (P - edge) * 0.07;
      const x0 = flat + r * 0.6;
      const g = ctx.createLinearGradient(x0, 0, x0 + span, 0);
      if (dark) {
        g.addColorStop(0, "rgba(255,255,255,0.07)");
        g.addColorStop(1, "rgba(255,255,255,0)");
      } else {
        g.addColorStop(0, "rgba(0,0,0,0.28)");
        g.addColorStop(0.35, "rgba(0,0,0,0.1)");
        g.addColorStop(1, "rgba(0,0,0,0)");
      }
      ctx.fillStyle = g;
      ctx.fillRect(x0, y0, span, h);
    }

    // Flat, the front.
    if (flat > 0) ctx.drawImage(front, 0, sy, flat * K, sh, 0, y0, flat, h);

    // Up the roll, still the front: squeezed as it turns away, darker underneath.
    const frontEnd = Math.min(Math.PI / 2, turned);
    for (let j = 0; j < ROLL_STEPS; j++) {
      const a = (frontEnd * j) / ROLL_STEPS, b = (frontEnd * (j + 1)) / ROLL_STEPS;
      const xa = flat + r * Math.sin(a), xb = flat + r * Math.sin(b);
      if (xb - xa < 0.05) continue;
      ctx.drawImage(front, (flat + a * r) * K, sy, (b - a) * r * K, sh, xa, y0, xb - xa, h);
      const m = (a + b) / 2 / (Math.PI / 2);
      ctx.fillStyle = `rgba(0,0,0,${(dark ? 0.55 : 0.42) * m * m})`;
      ctx.fillRect(xa, y0, xb - xa, h);
    }

    // Over the top of the roll, the back: dark where it turns down, lit across
    // the top, with one soft highlight.
    if (turned > Math.PI / 2) {
      const backEnd = Math.min(Math.PI, turned);
      for (let j = 0; j < ROLL_STEPS; j++) {
        const a = Math.PI / 2 + ((backEnd - Math.PI / 2) * j) / ROLL_STEPS;
        const b = Math.PI / 2 + ((backEnd - Math.PI / 2) * (j + 1)) / ROLL_STEPS;
        const xa = flat + r * Math.sin(a), xb = flat + r * Math.sin(b);
        drawBack(ctx, f, flat + a * r, flat + b * r, xa, xb, y0, h, sy, sh);
        const m = (a + b) / 2;
        const lit = Math.sin(m - Math.PI / 2);
        const hi = Math.exp(-Math.pow((m - Math.PI * 0.8) / 0.22, 2));
        ctx.fillStyle = dark
          ? `rgba(255,255,255,${0.05 * lit + 0.16 * hi})`
          : hi > 0.4 ? `rgba(255,255,255,${0.3 * hi})` : `rgba(0,0,0,${0.32 * (1 - lit)})`;
        ctx.fillRect(xb, y0, xa - xb, h);
      }
      // A narrow line where the page meets itself, at the roll's outer edge.
      ctx.fillStyle = dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.38)";
      ctx.fillRect(flat + r - 0.6, y0, 1, h);
    }

    // The flap, back over the page; its print foreshortened a little near the roll.
    if (over) {
      const start = flat + Math.PI * r;
      const len = P - start;
      const near = Math.min(len, r * 2.2);
      const along = (t: number) => t * (1 - 0.16 * Math.exp(-t / (1.4 * r)));
      const parts = 6;
      for (let j = 0; j < parts; j++) {
        const a = (near * j) / parts, b = (near * (j + 1)) / parts;
        drawBack(ctx, f, start + a, start + b, flat - along(a), flat - along(b), y0, h, sy, sh);
      }
      if (len > near) drawBack(ctx, f, start + near, P, flat - along(near), flat - along(len), y0, h, sy, sh);
      const edgeX = flat - along(len);
      if (dark) {
        // A rim of light along the free edge.
        ctx.fillStyle = "rgba(255,255,255,0.22)";
        ctx.fillRect(edgeX - 0.6, y0, 1.2, h);
      } else {
        const g = ctx.createLinearGradient(edgeX, 0, edgeX - 10, 0);
        g.addColorStop(0, "rgba(0,0,0,0.18)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(edgeX - 10, y0, 10, h);
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.fillRect(edgeX - 0.4, y0, 0.8, h);
      }
    }
  }
  return { radius: r, bow: Math.round(rowEdge(f, 0) - rowEdge(f, f.grip * H)) };
}

/** Hardcover: see the file comment. */
export function paintHardcover(ctx: CanvasRenderingContext2D, f: TurnStyleFrame): TurnStyleInfo {
  const { width: P, height: H, imageScale: K, dark } = f;
  const theta = Math.min(1, Math.max(0, f.pull)) * Math.PI;
  const curl = P * 0.07;
  const D = P * 3.4;
  drawStill(ctx, f);

  // The page's shape: a small curl where it leaves the spine, stiff after.
  const N = 160;
  const pts = [{ s: 0, x: 0, z: 0, a: 0 }];
  let x = 0, z = 0;
  for (let i = 1; i <= N; i++) {
    const s = (P * i) / N, ds = P / N;
    const u = Math.min(1, (s - ds / 2) / curl);
    const a = theta * (u * u * (3 - 2 * u));
    x += Math.cos(a) * ds;
    z += Math.sin(a) * ds;
    pts.push({ s, x, z, a });
  }
  const proj = (p: { x: number; z: number }) => { const k = D / (D - p.z); return { x: p.x * k, k }; };

  // Its shadow (a glow on dark paper) on whatever it is over.
  const lift = Math.sin(theta);
  if (lift > 0.01 && f.shadow) {
    const end = proj(pts[N]!).x;
    const span = Math.abs(end) * 0.5 + 20;
    const toLeft = end < 0;
    const g = ctx.createLinearGradient(0, 0, toLeft ? -span : span, 0);
    if (dark) {
      g.addColorStop(0, `rgba(255,255,255,${0.06 * lift})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
    } else {
      g.addColorStop(0, `rgba(0,0,0,${0.3 * lift})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
    }
    ctx.fillStyle = g;
    ctx.fillRect(toLeft ? -span : 0, 0, span, H);
  }

  for (let i = 0; i < N; i++) {
    const A = proj(pts[i]!), B = proj(pts[i + 1]!);
    const a = (pts[i]!.a + pts[i + 1]!.a) / 2;
    const k = (A.k + B.k) / 2;
    const top = H / 2 - (H / 2) * k, h = H * k;
    const x0 = Math.min(A.x, B.x), w = Math.abs(B.x - A.x);
    if (w < 0.02) continue;
    const s0 = pts[i]!.s, s1 = pts[i + 1]!.s;
    if (Math.cos(a) > 0) {
      ctx.drawImage(f.images.front, s0 * K, 0, (s1 - s0) * K, H * K, x0, top, w, h);
      ctx.fillStyle = dark ? `rgba(255,255,255,${0.1 * Math.sin(a)})` : `rgba(0,0,0,${0.32 * (1 - Math.cos(a))})`;
    } else {
      // The back: whole columns of the page, top to bottom.
      drawBack(ctx, f, s0, s1, x0 + w, x0, top, h, 0, H * K);
      ctx.fillStyle = dark ? `rgba(255,255,255,${0.1 * Math.sin(a)})` : `rgba(0,0,0,${0.32 * (1 + Math.cos(a))})`;
    }
    ctx.fillRect(x0, top, w, h);
  }
  // The free edge.
  const E = proj(pts[N]!);
  ctx.fillStyle = dark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.3)";
  ctx.fillRect(E.x - 0.6, H / 2 - (H / 2) * E.k, 1.2, H * E.k);
  return { angle: (theta * 180) / Math.PI };
}

/** One frame of a page turn in the chosen style, spine at x = 0. */
export function paintTurnStyle(ctx: CanvasRenderingContext2D, f: TurnStyleFrame): TurnStyleInfo {
  return f.style === "hardcover" ? paintHardcover(ctx, f) : paintPaperback(ctx, f);
}
