/**
 * Device-local preference: how much the pen's pace changes what it lays down.
 *
 * Off by default. It is a real change to how handwriting looks, and the right
 * amount is a matter of taste and of how fast the writer's hand actually moves
 * — so it is a dial someone turns up on purpose, not something that arrives
 * with an update and makes their existing notes look different.
 */

import { numberPref } from "./prefStore";
const KEY = "whiteboard.inkSpeed";
/** Soft rim + dwell growth feel (0 = hard expanding disc, 1 = soft rim / faster grow). */
const BLOT_BLEND_KEY = "whiteboard.inkSpeedBlotBlend";
/** Pace wash toward paper (0 = width only, 1 = full drying curve). */
const FADE_KEY = "whiteboard.inkSpeedFade";
/** Nib material: 0 = hard felt-tip, 1 = seeded overlapping discs. */
const GRAIN_KEY = "whiteboard.inkGrain";

export const INK_SPEED_MIN = 0;
export const INK_SPEED_MAX = 1;
export const INK_SPEED_DEFAULT = 0;

/** Off: speed ink is the ordinary pen with pace-varying width. Pencil pooling is opt-in. */
export const INK_SPEED_BLOT_BLEND_DEFAULT = 0;
/** Width-only until the writer turns the wash up. */
export const INK_SPEED_FADE_DEFAULT = 0;
/** Off: hard marker disc. Texture is opt-in so old notes stay a felt-tip. */
export const INK_GRAIN_DEFAULT = 0;

function clamp(value: number, fallback = INK_SPEED_DEFAULT): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(INK_SPEED_MAX, Math.max(INK_SPEED_MIN, value));
}

const speedPref = numberPref({ key: KEY, min: INK_SPEED_MIN, max: INK_SPEED_MAX, fallback: INK_SPEED_DEFAULT });
const blotBlendPref = numberPref({ key: BLOT_BLEND_KEY, min: INK_SPEED_MIN, max: INK_SPEED_MAX, fallback: INK_SPEED_BLOT_BLEND_DEFAULT });
const fadePref = numberPref({ key: FADE_KEY, min: INK_SPEED_MIN, max: INK_SPEED_MAX, fallback: INK_SPEED_FADE_DEFAULT });
const grainPref = numberPref({ key: GRAIN_KEY, min: INK_SPEED_MIN, max: INK_SPEED_MAX, fallback: INK_GRAIN_DEFAULT });

/** Stored as 0–1; the UI shows 0–100%. */
export function loadInkSpeed(): number {
  return speedPref.load();
}

export function saveInkSpeed(value: number): void {
  speedPref.save(value);
}

export function speedInkFromPercent(percent: number): number {
  return clamp(percent / 100);
}

export function speedInkToPercent(value: number): number {
  return Math.round(clamp(value) * 100);
}

/** 0 = hard expanding disc; 1 = wider soft rim + faster dwell growth. */
export function loadInkSpeedBlotBlend(): number {
  return blotBlendPref.load();
}

export function saveInkSpeedBlotBlend(value: number): void {
  blotBlendPref.save(value);
}

export function speedBlotBlendFromPercent(percent: number): number {
  return clamp(percent / 100, INK_SPEED_BLOT_BLEND_DEFAULT);
}

export function speedBlotBlendToPercent(value: number): number {
  return Math.round(clamp(value, INK_SPEED_BLOT_BLEND_DEFAULT) * 100);
}

/** Fired when Ink Pooling blend is saved so the board can re-read it. */
export const INK_SPEED_BLOT_BLEND_EVENT = "lc-ink-speed-blot-blend";

export function loadInkSpeedFade(): number {
  return fadePref.load();
}

export function saveInkSpeedFade(value: number): void {
  fadePref.save(value);
}

export function speedFadeFromPercent(percent: number): number {
  return clamp(percent / 100, INK_SPEED_FADE_DEFAULT);
}

export function speedFadeToPercent(value: number): number {
  return Math.round(clamp(value, INK_SPEED_FADE_DEFAULT) * 100);
}

/** Fired when Ink Drying (pace wash) is saved so the board can re-read it. */
export const INK_SPEED_FADE_EVENT = "lc-ink-speed-fade";

export function loadInkGrain(): number {
  return grainPref.load();
}

export function saveInkGrain(value: number): void {
  grainPref.save(value);
}

export function grainFromPercent(percent: number): number {
  return clamp(percent / 100, INK_GRAIN_DEFAULT);
}

export function grainToPercent(value: number): number {
  return Math.round(clamp(value, INK_GRAIN_DEFAULT) * 100);
}

/** Fired when Grain is saved so the board can re-read it. */
export const INK_GRAIN_EVENT = "lc-ink-grain";
