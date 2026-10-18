import type { PageFrame } from "./inkPageIndex";

/** Freeze at most two adjacent pages from the starting viewport, never the book. */
export function readingZoomSpan(
  frames: readonly PageFrame[], top: number, bottom: number, anchorY: number,
): { minY: number; maxY: number } | null {
  if (!frames.length) return null;
  let index = 0, distance = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const d = Math.max(f.minY - anchorY, anchorY - f.maxY, 0);
    if (d < distance) { index = i; distance = d; }
  }
  const selected = frames[index]!;
  const overlap = (f: PageFrame) => Math.max(0, Math.min(bottom, f.maxY) - Math.max(top, f.minY));
  const neighbours = [frames[index - 1], frames[index + 1]].filter((f): f is PageFrame => !!f && overlap(f) > 1);
  const other = neighbours.sort((a, b) => overlap(b) - overlap(a))[0];
  return { minY: Math.min(selected.minY, other?.minY ?? selected.minY),
    maxY: Math.max(selected.maxY, other?.maxY ?? selected.maxY) };
}

/**
 * How far a pinch may zoom in. Relative to the column's width fit, not to the
 * visible pages: those include the page below, so at the usual width a pinch
 * stopped just past where it began and each pinch could only go a bit further.
 */
export function readingZoomCeiling(floor: number, widthFit: number, baseZoom: number, range: number, max: number): number {
  return Math.max(max, Math.max(floor, widthFit) * range, baseZoom);
}

/** One two-finger gesture: a pan at a fixed zoom, or a zoom. */
export interface PinchTrack {
  mode: "idle" | "zoom" | "pan";
  /** Spread and zoom the current zoom is measured from. */
  d0: number;
  z0: number;
  /** Where the fingers' midpoint started. */
  m0: { x: number; y: number };
  /** Recent samples, for telling a pan from a pinch. */
  recent: Array<{ t: number; d: number; x: number; y: number }>;
}

export function newPinchTrack(d: number, z: number, mid: { x: number; y: number }): PinchTrack {
  return { mode: "idle", d0: d, z0: z, m0: mid, recent: [] };
}

/** Spread change that makes an undecided touch a pinch. */
export const PINCH_BAND = 0.06;
/** Spread change that turns a pan back into a pinch: a deliberate one. */
export const PINCH_REZOOM = 0.15;
/** Midpoint travel (CSS px) that makes an undecided touch a pan. */
export const PINCH_PAN_START = 24;
/** Window and ratio for "the fingers are travelling, not spreading". */
export const PINCH_WINDOW_MS = 150;
export const PINCH_PAN_RATIO = 4;
const PINCH_PAN_MIN = 12;

/**
 * The zoom for this sample. Two fingers moving together pan at a fixed zoom;
 * only a change in their spread zooms. Fingers sliding together never keep
 * the same spread, and every wobble of it used to zoom the page in and out.
 */
export function pinchZoom(track: PinchTrack, d: number, mid: { x: number; y: number }, now: number, currentZoom: number): number {
  track.recent.push({ t: now, d, x: mid.x, y: mid.y });
  while (track.recent.length > 2 && now - track.recent[0]!.t > PINCH_WINDOW_MS) track.recent.shift();
  const spread = Math.abs(d / track.d0 - 1);
  if (track.mode === "idle") {
    if (spread >= PINCH_BAND) {
      // Zoom from this spread, so leaving the band does not jump.
      Object.assign(track, { mode: "zoom", d0: d });
    } else if (Math.hypot(mid.x - track.m0.x, mid.y - track.m0.y) > PINCH_PAN_START) {
      Object.assign(track, { mode: "pan", d0: d });
    }
    return track.z0;
  }
  if (track.mode === "pan") {
    if (spread >= PINCH_REZOOM) Object.assign(track, { mode: "zoom", d0: d });
    return track.z0;
  }
  const first = track.recent[0]!;
  const travel = Math.hypot(mid.x - first.x, mid.y - first.y), change = Math.abs(d - first.d);
  if (travel > PINCH_PAN_MIN && travel > PINCH_PAN_RATIO * change) {
    Object.assign(track, { mode: "pan", z0: currentZoom, d0: d });
    return currentZoom;
  }
  return track.z0 * (d / track.d0);
}
