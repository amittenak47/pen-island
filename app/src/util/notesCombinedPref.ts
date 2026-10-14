/**
 * Whether the footnote panel shows a footnote's notes as one combined note.
 * A display choice for this device only; the notes themselves are unchanged.
 */

import { boolPref } from "./prefStore";
const KEY = "whiteboard.footnoteNotesCombined.v1";

const combinedPref = boolPref({ key: KEY, fallback: false });

export function loadNotesCombined(): boolean {
  return combinedPref.load();
}

export function saveNotesCombined(combined: boolean): void {
  combinedPref.save(combined);
}
