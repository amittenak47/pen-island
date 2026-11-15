/** A held page's span in scene units. */
export interface LockSpan {
  minY: number;
  maxY: number;
}

/**
 * Whether a jump to `frameMinY` lands on the page the lock has just fitted
 * the camera on, so the jump has nothing to measure or move.
 *
 * `fitted` is the lock the page fit placed in this task, `held` the lock in
 * force now. Only the same lock counts: a lock set again since, or released,
 * has not been fitted. A page turn's landing jumps to a point within its page
 * (where a zoomed-in hand had it), so the point must be inside the span.
 */
export function jumpLandsOnFittedLock(
  fitted: LockSpan | null,
  held: LockSpan | null,
  fitOn: boolean,
  frameMinY: number,
): boolean {
  return fitOn && fitted != null && fitted === held && frameMinY >= fitted.minY - 0.5 && frameMinY < fitted.maxY;
}
