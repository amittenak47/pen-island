/** Booktab geometry. The historical AI name also covers tabs for other footnotes. */

export const AI_TAB_WIDTH = 28;
export const AI_TAB_HEIGHT = 18;
export const AI_TAB_STACK_GAP = 20;

export function aiBookTabLeft(tabWidth = AI_TAB_WIDTH): number {
  return -tabWidth / 2;
}

/**
 * Keep tabs from stacking on the same band. Input Y is the passage top.
 * Returns a top for each id, in the same order as `items`.
 */
export function stackAiTabTops(
  items: ReadonlyArray<{ id: string; y: number }>,
  minGap = AI_TAB_STACK_GAP,
): Map<string, number> {
  const ordered = [...items].sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
  const out = new Map<string, number>();
  let last = Number.NEGATIVE_INFINITY;
  for (const item of ordered) {
    const top = item.y < last + minGap ? last + minGap : item.y;
    out.set(item.id, top);
    last = top;
  }
  return out;
}

export type BooktabRect = { left: number; top: number; width: number; height: number };
export const BOOKTAB_EDGE_GAP = 4;
export const BOOKTAB_MIN_WIDTH = 12;

/** Ordered tabs run left to right, with half their height outside the sheet. */
export function edgeBookTabRects(
  page: BooktabRect,
  edge: "top" | "bottom",
  tabs: ReadonlyArray<{ id: string }>,
): Map<string, BooktabRect> {
  const out = new Map<string, BooktabRect>();
  if (!tabs.length || page.width <= 0 || page.height <= 0) return out;
  const inset = Math.min(BOOKTAB_EDGE_GAP, page.width / 4);
  const available = page.width - inset * 2;
  const count = tabs.length;
  // Shrink widths to 12px first, then close the gaps. In the pathological
  // case where even gapless minimum widths cannot fit, fitting takes priority.
  const width = Math.min(AI_TAB_HEIGHT, Math.max(BOOKTAB_MIN_WIDTH,
    (available - BOOKTAB_EDGE_GAP * (count - 1)) / count), available / count);
  const gap = count > 1 ? Math.max(0, Math.min(BOOKTAB_EDGE_GAP,
    (available - width * count) / (count - 1))) : 0;
  const height = AI_TAB_WIDTH;
  const top = page.top + (edge === "bottom" ? page.height : 0) - height / 2;
  tabs.forEach((tab, index) => out.set(tab.id, {
    left: page.left + inset + index * (width + gap), top, width, height,
  }));
  return out;
}
