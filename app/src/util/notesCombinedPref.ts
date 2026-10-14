/**
 * Whether the footnote panel shows a footnote's notes as one combined note.
 * A display choice for this device only; the notes themselves are unchanged.
 */

const KEY = "whiteboard.footnoteNotesCombined.v1";

export function loadNotesCombined(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function saveNotesCombined(combined: boolean): void {
  try { localStorage.setItem(KEY, combined ? "1" : "0"); } catch { /* a convenience only */ }
}
