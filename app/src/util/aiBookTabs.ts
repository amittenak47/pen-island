/** Booktab geometry. The historical AI name also covers tabs for other footnotes. */

export const AI_TAB_WIDTH = 28;
export const AI_TAB_HEIGHT = 18;
export const AI_TAB_STACK_GAP = 20;

export function aiBookTabLeft(tabWidth = AI_TAB_WIDTH): number {
  return -tabWidth / 2;
}

/** Room a square's caption takes above it (one 9px line, its 2px lift, and air). */
export const CAPTION_STACK_ROOM = 14;

/**
 * Keep tabs from stacking on the same band. `y` is the passage's first line;
 * `yLast` its last line (the same as `y` for a one-line passage); `above` is
 * room the tab needs over its top (its caption). Returns a top for each id,
 * never above `minTop`.
 *
 * A tab is on its passage anywhere from its first line to its last, and with
 * room to spare it stays on the first line. A run of tabs too close to fit
 * first uses that freedom: a later tab drops to a lower line of its own
 * passage. Only what still does not fit is spread past the passages, centred
 * on them rather than pushed only downward: the least-squares fit (distance
 * outside each passage) under the spacing, by pool adjacent violators.
 */
export function stackAiTabTops(
  items: ReadonlyArray<{ id: string; y: number; yLast?: number; above?: number }>,
  minGap = AI_TAB_STACK_GAP,
  minTop = Number.NEGATIVE_INFINITY,
): Map<string, number> {
  const ordered = [...items].sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
  // How far each top must be below the first, if the whole run were packed.
  const offsets: number[] = [];
  ordered.forEach((item, index) => {
    offsets.push(index === 0 ? 0 : offsets[index - 1]! + minGap + (item.above ?? 0));
  });
  // Packed, a tab's top is its offset plus one shared shift; in shift terms
  // each tab is happy anywhere in [lo, hi].
  const ranges = ordered.map((item, index) => ({
    lo: item.y - offsets[index]!,
    hi: Math.max(item.y, item.yLast ?? item.y) - offsets[index]!,
  }));
  // The best shift for a run: the highest one where moving lower stops
  // helping (the left end of the minimum of a sum of squared distances).
  const bestShift = (from: number, to: number): number => {
    let low = Number.POSITIVE_INFINITY, high = Number.NEGATIVE_INFINITY;
    for (let k = from; k < to; k += 1) { low = Math.min(low, ranges[k]!.lo); high = Math.max(high, ranges[k]!.hi); }
    const slope = (shift: number) => {
      let total = 0;
      for (let k = from; k < to; k += 1) {
        const { lo, hi } = ranges[k]!;
        if (shift < lo) total += shift - lo; else if (shift > hi) total += shift - hi;
      }
      return total;
    };
    for (let step = 0; step < 48 && high - low > 0.01; step += 1) {
      const mid = (low + high) / 2;
      if (slope(mid) >= 0) high = mid; else low = mid;
    }
    return high;
  };
  // Merge runs until the shifts never decrease, so no tab overlaps the one before.
  const blocks: Array<{ from: number; to: number; shift: number }> = [];
  ordered.forEach((_, index) => {
    blocks.push({ from: index, to: index + 1, shift: bestShift(index, index + 1) });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!, prev = blocks[blocks.length - 2]!;
      if (prev.shift <= last.shift) break;
      blocks.splice(blocks.length - 2, 2, { from: prev.from, to: last.to, shift: bestShift(prev.from, last.to) });
    }
  });
  const out = new Map<string, number>();
  // Held below `minTop` (the first top is offset 0), and never above the run before.
  let floor = minTop;
  for (const block of blocks) {
    const shift = Math.max(block.shift, floor);
    floor = shift;
    for (let index = block.from; index < block.to; index += 1) {
      out.set(ordered[index]!.id, Math.round(shift + offsets[index]!));
    }
  }
  return out;
}

/** Passages whose first lines are this close share a row of squares. */
export const SAME_ROW_TOLERANCE = 6;

export interface MarginSquare {
  id: string;
  /** First and last line of the passage. */
  y: number;
  yLast: number;
  /** Where the passage starts on its line, for reading order within a row. */
  x: number;
  number: number;
  /** It shows a caption above itself. */
  caption: boolean;
}

export interface MarginSquarePlace {
  top: number;
  /** Squares in from the page edge: 0 is at the edge, 1 is beside it, and so on. */
  slot: number;
  /** Caption lines below this one in its row's stack: 0 is the line just above the squares. */
  captionLine: number;
}

/**
 * Where each margin square goes, with its caption.
 *
 * Passages that start on the same line get one row of squares, side by side
 * in reading order (the last nearest the page edge), with their captions
 * stacked above, one line each: the first square's caption lowest. Rows are
 * then stacked by {@link stackAiTabTops}, each reserving its caption lines,
 * and may drop within the lines its passages share.
 */
export function placeMarginSquares(
  items: ReadonlyArray<MarginSquare>,
  minGap = AI_TAB_STACK_GAP,
  minTop = Number.NEGATIVE_INFINITY,
): Map<string, MarginSquarePlace> {
  const ordered = [...items].sort((a, b) => a.y - b.y || a.x - b.x || a.number - b.number);
  const rows: MarginSquare[][] = [];
  for (const item of ordered) {
    const row = rows[rows.length - 1];
    if (row && item.y - row[0]!.y <= SAME_ROW_TOLERANCE) row.push(item);
    else rows.push([item]);
  }
  const tops = stackAiTabTops(rows.map((row, index) => {
    const y = Math.min(...row.map(item => item.y));
    // Every square in the row stays beside a line of its own passage.
    const yLast = Math.max(y, Math.min(...row.map(item => Math.max(item.y, item.yLast))));
    return { id: String(index), y, yLast, above: row.filter(item => item.caption).length * CAPTION_STACK_ROOM };
  }), minGap, minTop);
  const out = new Map<string, MarginSquarePlace>();
  rows.forEach((row, index) => {
    const top = tops.get(String(index))!;
    row.sort((a, b) => a.x - b.x || a.number - b.number);
    let line = 0;
    row.forEach((item, at) => {
      out.set(item.id, { top, slot: row.length - 1 - at, captionLine: line });
      if (item.caption) line += 1;
    });
  });
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
