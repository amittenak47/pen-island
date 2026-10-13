/** ChatBot bookmarks hang halfway off the left edge, opposite the footnote controls. */

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
