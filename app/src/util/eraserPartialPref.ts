/**
 * Device-local preference: does the eraser rub pixels out, or take the stroke?
 *
 * On by default, because the pixel eraser is the one people are surprised by
 * and then keep — at a small radius it bites the side of a letter and leaves
 * the rest, the way a real eraser does, and thinning a stroke or opening a gap
 * is not something the other kind can do at all.
 *
 * Off is for diagrams. Removing one wrong line out of a sketch with a pixel
 * eraser means tracing the line; touching it anywhere ought to be enough.
 */

import { boolPref } from "./prefStore";
const KEY = "whiteboard.eraser.partial";

export const ERASER_PARTIAL_DEFAULT = true;

/** Fired on the window when the preference changes, so open boards pick it up. */
export const ERASER_PARTIAL_EVENT = "lc-eraser-partial";

const partialPref = boolPref({ key: KEY, fallback: ERASER_PARTIAL_DEFAULT });

export function loadEraserPartial(): boolean {
  return partialPref.load();
}

export function saveEraserPartial(partial: boolean): void {
  partialPref.save(partial);
}
