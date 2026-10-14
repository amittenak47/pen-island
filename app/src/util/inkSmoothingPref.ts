/** Device-local preference: how hard to smooth a stroke, and when to do it. */

import { numberPref, enumPref, boolPref } from "./prefStore";
import {
  INK_SMOOTHING_DEFAULT,
  INK_SMOOTHING_MODE_DEFAULT,
  type InkSmoothingMode,
} from "../canvas/inkSmoothing";

const KEY = "whiteboard.inkSmoothing";
const MODE_KEY = "whiteboard.inkSmoothingMode";
const CLOTHOID_KEY = "whiteboard.inkClothoid";
const CAPILLARY_KEY = "whiteboard.inkCapillary";

export const INK_SMOOTHING_MIN = 0;
export const INK_SMOOTHING_MAX = 1;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return INK_SMOOTHING_DEFAULT;
  return Math.min(INK_SMOOTHING_MAX, Math.max(INK_SMOOTHING_MIN, value));
}

const smoothingPref = numberPref({ key: KEY, min: INK_SMOOTHING_MIN, max: INK_SMOOTHING_MAX, fallback: INK_SMOOTHING_DEFAULT });
const smoothingModePref = enumPref<InkSmoothingMode>({ key: MODE_KEY, values: ["live", "lift"], fallback: INK_SMOOTHING_MODE_DEFAULT });
const clothoidPref = boolPref({ key: CLOTHOID_KEY, fallback: false });
const capillaryPref = boolPref({ key: CAPILLARY_KEY, fallback: false });

/** Stored as 0–1; the UI shows 0–100%. */
export function loadInkSmoothing(): number {
  return smoothingPref.load();
}

export function saveInkSmoothing(value: number): void {
  smoothingPref.save(value);
}

export function smoothingFromPercent(percent: number): number {
  return clamp(percent / 100);
}

export function smoothingToPercent(value: number): number {
  return Math.round(clamp(value) * 100);
}

export function loadInkSmoothingMode(): InkSmoothingMode {
  return smoothingModePref.load();
}

export function saveInkSmoothingMode(mode: InkSmoothingMode): void {
  smoothingModePref.save(mode);
}

/** Lift-time Euler spiral. Off until turned on in pen settings. */
export function loadInkClothoid(): boolean {
  return clothoidPref.load();
}

export function saveInkClothoid(on: boolean): void {
  clothoidPref.save(on);
}

/** Lift-time Laplacian relax. Off until turned on in pen settings. */
export function loadInkCapillary(): boolean {
  return capillaryPref.load();
}

export function saveInkCapillary(on: boolean): void {
  capillaryPref.save(on);
}

export { INK_SMOOTHING_DEFAULT, INK_SMOOTHING_MODE_DEFAULT, type InkSmoothingMode };
