/**
 * Glass over a note's text while scroll reading moves the page.
 *
 * Every touch starts with the browser looking up what is under the finger:
 * four times a touch on the tablet, 3-8 ms each over a chapter of math, and
 * Chromium's ad detector looks up the middle of the screen once a second
 * while frames run (3-14 ms each). Over the text, each walks every KaTeX
 * part drawn. While the page moves, the board's own `::after` lies over the
 * text (`.lc-board[data-scroll-glass]` in styles.css, the same glass page
 * turns use): a lookup ends on it at once, on the board, and a touch that
 * catches or flings on reaches the board as it does now.
 *
 * Presses reach the board and not the text, so the glass comes off when the
 * camera settles, and is never up while the text is being marked or edited.
 */

/** Over the text, unless it is being marked or edited. */
export function raiseScrollGlass(board: HTMLElement | null, text: HTMLElement | null): void {
  if (!board || !text) return;
  if (board.classList.contains("lc-board-highlighting") || text.classList.contains("lc-page-content-editing")) return;
  if (board.dataset.scrollGlass !== "on") board.dataset.scrollGlass = "on";
}

/** Off, left in place: raising it again is a style change, not a new box. */
export function lowerScrollGlass(board: HTMLElement | null): void {
  if (board?.dataset.scrollGlass === "on") board.dataset.scrollGlass = "";
}
