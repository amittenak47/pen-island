/**
 * Where a reader is in a text document, as a place in its scene.
 *
 * Markdown, code, text and EPUB have no pages of their own: Pages reading cuts
 * them into screenfuls (see `sectionPages`), and those cuts move with the view
 * size and the chrome. So the place kept for them is a scene line, not a page
 * number: the top of the page held in Pages reading, or the line just under
 * the top chrome in scroll reading. Either mode can go back to it: scroll puts
 * that line at the top, Pages holds the page it falls on.
 */

import type { PageFrame } from "./inkPageIndex";
import type { ReadingPlace } from "../util/readingPosition";

export type { ReadingPlace } from "../util/readingPosition";

/**
 * The line being read now, or null before the document has a height.
 *
 * `held` is the page Pages reading holds; without one, the line under the top
 * chrome of `camera` (scrollY in board units, so the view's top is at
 * `-scrollY`).
 */
export function readingPlaceAt(input: {
  bounds: { minY: number };
  docHeight: number;
  held: { minY: number } | null;
  camera: { scrollY: number; zoom: number } | null;
  insetTop: number;
}): ReadingPlace | null {
  const { bounds, docHeight, held, camera, insetTop } = input;
  if (!(docHeight > 0)) return null;
  const line = held
    ? held.minY
    : camera && camera.zoom > 0
      ? Math.max(0, insetTop) / camera.zoom - camera.scrollY
      : Number.NaN;
  if (!Number.isFinite(line)) return null;
  return { y: Math.min(docHeight, Math.max(0, line - bounds.minY)), height: docHeight };
}

/**
 * The scene line `place` stands for in the document as laid out now. A
 * document that has grown or shrunk since keeps the same share of the way down.
 */
export function readingPlaceLine(
  place: ReadingPlace,
  bounds: { minY: number },
  docHeight: number,
): number {
  const height = docHeight > 0 ? docHeight : place.height;
  const scale = place.height > 0 && Math.abs(height - place.height) >= 1 ? height / place.height : 1;
  return bounds.minY + Math.min(height, Math.max(0, place.y * scale));
}

/** The camera scrollY that puts scene line `line` just under the top chrome. */
export function scrollYForLine(line: number, zoom: number, insetTop: number): number {
  return Math.max(0, insetTop) / (zoom > 0 ? zoom : 1) - line;
}

/**
 * The page a line falls on, else the nearest one; -1 with no pages.
 *
 * A held page's place is its own top, so the line is looked up a hair below
 * it: a page whose top moved by a rounding error must not hand the place to
 * the page above.
 */
export function pageIndexAtLine(frames: readonly PageFrame[], line: number): number {
  if (frames.length === 0 || !Number.isFinite(line)) return -1;
  const y = line + 0.5;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i]!;
    if (y >= f.minY && y < f.maxY) return i;
    const dist = Math.min(Math.abs(y - f.minY), Math.abs(y - f.maxY));
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** The scene line in the middle of a saved camera's view: the page it shows. */
export function viewMiddleLine(camera: { scrollY: number; zoom: number }, viewHeight: number): number {
  const zoom = camera.zoom > 0 ? camera.zoom : 1;
  return viewHeight / 2 / zoom - camera.scrollY;
}
