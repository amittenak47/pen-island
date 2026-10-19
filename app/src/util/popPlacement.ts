/**
 * Where a small notification goes next to the button it belongs to.
 *
 * Below the button with its left edge on the button's left; when that would
 * run past the right side of the window, its right edge on the button's right
 * instead (a button near the right edge, like Home's sync). Above the button
 * when there is no room below. Always at least `margin` inside the window.
 *
 * It never covers its button: when it does not fit on either side it takes
 * the roomier one, and `maxHeight` is the room there (the notification
 * scrolls inside it). A kept side is kept the same way, so a list opening
 * inside an open notification grows into the room it has, not off screen.
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
  /** "right": its right edge on the button's right (the right half of a pair). */
  align: "left" | "right" = "left",
): { top: number; left: number; above: boolean; maxHeight: number } {
  const maxLeft = Math.max(margin, viewport.width - pop.width - margin);
  const leftAligned = button.left;
  const rightAligned = button.right - pop.width;
  const left = Math.min(maxLeft, Math.max(margin, align === "right"
    ? rightAligned >= margin ? rightAligned : leftAligned
    : leftAligned + pop.width + margin <= viewport.width ? leftAligned : rightAligned));
  const below = button.bottom + gap;
  const fitsBelow = below + pop.height + margin <= viewport.height;
  const above = button.top - gap - pop.height;
  const fitsAbove = above >= margin;
  const roomAbove = button.top - gap - margin;
  const roomBelow = viewport.height - below - margin;
  const useAbove = side ? side === "above"
    : !fitsAbove && !fitsBelow ? roomAbove > roomBelow
    : prefer === "above" ? fitsAbove : !fitsBelow;
  const maxHeight = Math.max(0, useAbove ? roomAbove : roomBelow);
  const top = useAbove ? button.top - gap - Math.min(pop.height, maxHeight) : below;
  return { top, left, above: useAbove, maxHeight };
}
