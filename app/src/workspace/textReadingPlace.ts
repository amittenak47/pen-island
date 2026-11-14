/**
 * The reading place of an open text document, kept on this device.
 *
 * A markdown note's camera was only ever written into its session, and a
 * session is written when the note changes. A note that is only read has no
 * session at all, so it reopened at the top after a relaunch, however far in
 * the reader was. While it is read, its place (see `readingPlace` on the
 * board) is taken every second and when the app goes to the background, and
 * an open goes back to it when it is newer than the session's own save.
 */

import type { BoardHandle } from "../canvas/BoardHandle";
import { loadReadingPlace, saveReadingPlace, type ReadingPlace, type ReadingPlaceKey } from "../util/readingPosition";

/** How often the place of a text document being read is taken. */
export const READING_PLACE_EVERY_MS = 1000;

/**
 * Documents whose place is a line of text: everything Pages reading cuts into
 * pages itself. A PDF keeps its page number (`readingPosition`); a web page
 * is not paged.
 */
export function keepsReadingPlace(docType: string | null | undefined): boolean {
  return docType != null && docType !== "pdf" && docType !== "web";
}

/**
 * On open: back to where this document was last read here, when that was
 * after the session's own save (`savedAt`, 0 with no session). The place gone
 * to, or null when there was none or the board could not use it.
 *
 * `key` names the document by its set's id and its content hash: a note that
 * was only read may come back under a new id, and is still the same file.
 */
export function restoreTextReadingPlace(
  board: Pick<BoardHandle, "goToReadingPlace"> | null | undefined,
  key: ReadingPlaceKey,
  savedAt: number,
): ReadingPlace | null {
  const place = loadReadingPlace(key, savedAt);
  if (!place || !board?.goToReadingPlace(place)) return null;
  return place;
}

/**
 * While a text document is read: take its place now and then. Returns the stop.
 *
 * `key` answers null until the open has been back to the saved place: a
 * document still opening sits at its top, and taking that would write over
 * the place it is about to go back to.
 */
export function trackTextReadingPlace(
  board: () => Pick<BoardHandle, "readingPlace"> | null | undefined,
  key: () => ReadingPlaceKey | null,
  everyMs = READING_PLACE_EVERY_MS,
): () => void {
  const take = () => {
    const which = key();
    if (which?.docId) saveReadingPlace(which, board()?.readingPlace() ?? null);
  };
  // Going to the background is the last chance: Android may end the app there.
  const hidden = () => {
    if (document.visibilityState === "hidden") take();
  };
  const timer = window.setInterval(take, everyMs);
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("pagehide", take);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", hidden);
    window.removeEventListener("pagehide", take);
  };
}
