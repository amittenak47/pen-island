import type { ExclusionRect } from "../../util/gestureExclusion";

type Box = { left: number; top: number; width: number; height: number };

export function turnCornerSize(rect: Box): number {
  return Math.min(rect.width / 2, rect.height / 2, 120, Math.max(44, rect.width * .12));
}

/** Only the four triangular corners start a page turn. */
export function turnCornerAt(rect: Box, x: number, y: number): "left" | "right" | null {
  const dx = x - rect.left, dy = y - rect.top;
  if (dx < 0 || dy < 0 || dx > rect.width || dy > rect.height) return null;
  const vertical = Math.min(dy, rect.height - dy), size = turnCornerSize(rect);
  if (dx + vertical <= size) return "left";
  if (rect.width - dx + vertical <= size) return "right";
  return null;
}

/** A side strip that takes hold of the page as it is touched: about 1.3 cm on the tablet. */
const EDGE_STRIP_PX = 64;
/** How far in a sideways drag still takes hold of it: about twice that. */
const EDGE_REACH_PX = 128;

/**
 * The side strips, peels keeping their corner shape, and the dark margin
 * beside the page out to the edge of the screen: a hand holding the tablet
 * rests its thumb there, not on the page.
 */
export function turnEdgeAt(rect: Box, x: number, y: number): "left" | "right" | null {
  const corner = turnCornerAt(rect, x, y);
  if (corner) return corner;
  const dx = x - rect.left, dy = y - rect.top;
  if (dy < 0 || dy > rect.height) return null;
  const strip = Math.min(EDGE_STRIP_PX, rect.width / 4);
  return dx <= strip ? "left" : rect.width - dx <= strip ? "right" : null;
}

/**
 * Inside a strip's reach, on the page: a thumb swinging in from the edge
 * lands here as often as on the strip. Unlike the strip it takes hold only
 * once the drag is plainly sideways, so a scroll or a hold to select that
 * starts here is still the page's.
 */
export function turnReachAt(rect: Box, x: number, y: number): "left" | "right" | null {
  const dx = x - rect.left, dy = y - rect.top;
  if (dx < 0 || dy < 0 || dx > rect.width || dy > rect.height) return null;
  const reach = Math.min(EDGE_REACH_PX, rect.width / 4);
  return dx <= reach ? "left" : rect.width - dx <= reach ? "right" : null;
}

/** Android accepts rectangles: short bands approximate each corner triangle. */
export function turnCornerExclusions(rect: Box, viewport: Box): ExclusionRect[] {
  const size = turnCornerSize(rect), bands = 6, step = size / bands;
  if (size <= 0) return [];
  const result: ExclusionRect[] = [];
  for (const right of [false, true]) for (const bottom of [false, true]) {
    for (let i = 0; i < bands; i++) {
      const width = size - i * step;
      const x = right ? rect.left + rect.width - width : rect.left;
      const y = bottom ? rect.top + rect.height - (i + 1) * step : rect.top + i * step;
      const left = Math.max(x, viewport.left), top = Math.max(y, viewport.top);
      const endX = Math.min(x + width, viewport.left + viewport.width);
      const endY = Math.min(y + step, viewport.top + viewport.height);
      if (endX > left && endY > top) result.push({ x: left, y: top, width: endX - left, height: endY - top });
    }
  }
  return result;
}
