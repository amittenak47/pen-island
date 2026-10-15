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

/** Most extra space a jittered tab adds before itself, in px. */
export const BOOKTAB_JITTER_GAP = 6;
/** Most a jittered tab sits off the edge line, either way, in px. */
export const BOOKTAB_JITTER_RISE = 1.5;

/** A stable 0..1 from a footnote id (FNV-1a), so a tab's jitter never moves. */
function idUnit(id: string, salt: number): number {
  let hash = 0x811c9dc5 ^ salt;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x100000000;
}

/**
 * Ordered tabs run left to right, with half their height outside the sheet.
 *
 * `jitter` spaces them a little unevenly and lifts each by a pixel or so, the
 * way tabs stuck on by hand sit. It comes from each footnote's id, so a tab
 * keeps its place between renders, and it only spends room the row has spare.
 */
export function edgeBookTabRects(
  page: BooktabRect,
  edge: "top" | "bottom",
  tabs: ReadonlyArray<{ id: string }>,
  jitter = false,
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
  const extras = tabs.map((tab, index) => jitter && index > 0 ? idUnit(tab.id, 1) * BOOKTAB_JITTER_GAP : 0);
  const spare = Math.max(0, available - width * count - gap * (count - 1));
  const wanted = extras.reduce((sum, extra) => sum + extra, 0);
  const squeeze = wanted > spare ? spare / wanted : 1;
  let left = page.left + inset;
  tabs.forEach((tab, index) => {
    if (index) left += width + gap + extras[index]! * squeeze;
    const rise = jitter ? (idUnit(tab.id, 2) * 2 - 1) * BOOKTAB_JITTER_RISE : 0;
    out.set(tab.id, { left, top: top + rise, width, height });
  });
  return out;
}
