/**
 * Where a small notification goes next to the button it belongs to.
 *
 * Below the button with its left edge on the button's left; when that would
 * run past the right side of the window, its right edge on the button's right
 * instead (a button near the right edge, like Home's sync). Above the button
 * when there is no room below. Always at least `margin` inside the window.
 */
export interface PopRect { top: number; left: number; bottom: number; right: number }

export function popPlacement(
  button: PopRect,
  pop: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
  margin = 8,
  /** "above": try above first (Home's sync icon), below only if it cannot fit. */
  prefer: "below" | "above" = "below",
  /** Keep this side (a notification that is already open must not flip when it resizes). */
  side?: "below" | "above",
): { top: number; left: number; above: boolean } {
  const maxLeft = Math.max(margin, viewport.width - pop.width - margin);
  const leftAligned = button.left;
  const rightAligned = button.right - pop.width;
  const left = Math.min(maxLeft, Math.max(margin, leftAligned + pop.width + margin <= viewport.width ? leftAligned : rightAligned));
  const below = button.bottom + gap;
  const fitsBelow = below + pop.height + margin <= viewport.height;
  const above = button.top - gap - pop.height;
  const fitsAbove = above >= margin;
  const useAbove = side ? side === "above" : prefer === "above" ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove;
  const top = useAbove ? Math.max(margin, above) : Math.max(margin, Math.min(below, viewport.height - pop.height - margin));
  return { top, left, above: useAbove };
}
