/**
 * Laid-out height of the paper inside the content slot.
 *
 * The slot's own border box is the page frame, which can sit at the 1100 floor
 * while the HTML overflows it. Inner `scrollHeight` is the number the pan clamp
 * needs when the frame-grow pass missed.
 */

export const DOCUMENT_LAYER_SELECTOR =
  ".lc-md-ink-doc, .lc-pdf-doc, .lc-web-doc-wrap, .lc-epub-doc, .lc-code-doc, .lc-md-edit-host";

/**
 * The document layers in `slot`: they sit within a few levels of it. Looked
 * for there first — a full `querySelectorAll` walks every KaTeX glyph of a
 * long note, ~50 ms on a tablet, and the page frames ask on every turn.
 */
function documentLayers(slot: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  const visit = (el: Element, depth: number) => {
    for (const child of Array.from(el.children)) {
      if (child.matches(DOCUMENT_LAYER_SELECTOR)) found.push(child as HTMLElement);
      else if (depth < 4) visit(child, depth + 1);
    }
  };
  visit(slot, 1);
  return found.length > 0 ? found : Array.from(slot.querySelectorAll<HTMLElement>(DOCUMENT_LAYER_SELECTOR));
}

/** Narrower than this and a laid-out box is not a column yet (see `MIN_MEASURABLE_WIDTH_PX`). */
const MIN_COLUMN_PX = 80;

/**
 * A box on screen but only a few pixels wide: a document mounted before its
 * slot has a width, one word per line and tens of thousands of pixels tall.
 * Its height means nothing, and the board keeps the tallest height it sees.
 */
function tooNarrowToMeasure(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && el.clientWidth < MIN_COLUMN_PX;
}

export function documentLayerHeight(slot: HTMLElement): number {
  let best = 0;
  for (const inner of documentLayers(slot)) {
    if (tooNarrowToMeasure(inner)) continue;
    best = Math.max(best, inner.scrollHeight, inner.offsetHeight);
  }
  // The slot includes the frame's tail padding. Feeding that back into frame
  // growth adds the padding again on each ResizeObserver delivery.
  if (best > 0) return best;
  return tooNarrowToMeasure(slot) ? 0 : slot.scrollHeight;
}
