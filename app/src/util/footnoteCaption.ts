/** Widest a footnote title on the page may be (it is ellipsized past this). */
export const CAPTION_MAX_WIDTH = 136;
/** Narrower than this, a title is left off the page rather than cut to a stub. */
export const CAPTION_MIN_WIDTH = 40;
/** Clear space between the text column and the title. */
export const CAPTION_GAP = 6;

/**
 * How wide a footnote's title may be beside its square, or 0 to leave it off.
 *
 * The title sits above the square and runs left, over the line above, so it
 * may only use the margin between the text column's right edge and the
 * square's right edge. Too narrow to read, and it is left off the page; the
 * footnote panel always shows the title.
 */
export function footnoteCaptionRoom(chipRight: number, textRight: number): number {
  const room = Math.min(CAPTION_MAX_WIDTH, chipRight - textRight - CAPTION_GAP);
  return room >= CAPTION_MIN_WIDTH ? room : 0;
}
