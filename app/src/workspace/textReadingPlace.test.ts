/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadReadingPlace, saveReadingPlace } from "../util/readingPosition";
import { keepsReadingPlace, READING_PLACE_EVERY_MS, restoreTextReadingPlace, trackTextReadingPlace } from "./textReadingPlace";

const note = { docId: "mdink-first", hash: "md1296asv-6a7w" };

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("keepsReadingPlace", () => {
  it("is for documents Pages reading cuts itself, not PDFs or web pages", () => {
    for (const docType of ["markdown", "code", "text", "epub"]) expect(keepsReadingPlace(docType)).toBe(true);
    for (const docType of ["pdf", "web", null, undefined]) expect(keepsReadingPlace(docType)).toBe(false);
  });
});

describe("restoreTextReadingPlace", () => {
  it("goes back to the place read to since the last save, or with no session at all", () => {
    saveReadingPlace(note, { y: 8420, height: 113574 });
    const board = { goToReadingPlace: vi.fn(() => true) };
    expect(restoreTextReadingPlace(board, note, 0)).toEqual({ y: 8420, height: 113574 });
    expect(board.goToReadingPlace).toHaveBeenCalledWith({ y: 8420, height: 113574 });
  });

  it("finds a note that was only read when it comes back under a new id", () => {
    saveReadingPlace(note, { y: 5541, height: 113753 });
    const board = { goToReadingPlace: vi.fn(() => true) };
    expect(restoreTextReadingPlace(board, { docId: "mdink-second", hash: note.hash }, 0))
      .toEqual({ y: 5541, height: 113753 });
    expect(restoreTextReadingPlace(board, { docId: "mdink-other", hash: "md-another-file" }, 0)).toBeNull();
  });

  it("leaves a session saved after the reading on its own camera", () => {
    saveReadingPlace(note, { y: 8420, height: 113574 });
    const board = { goToReadingPlace: vi.fn(() => true) };
    expect(restoreTextReadingPlace(board, note, 200_000)).toBeNull();
    expect(board.goToReadingPlace).not.toHaveBeenCalled();
  });

  it("says nothing was restored when the board could not go there", () => {
    saveReadingPlace(note, { y: 10, height: 100 });
    expect(restoreTextReadingPlace({ goToReadingPlace: () => false }, note, 0)).toBeNull();
    expect(restoreTextReadingPlace(null, note, 0)).toBeNull();
  });
});

describe("trackTextReadingPlace", () => {
  it("takes the place every second while the document is read, and stops", () => {
    let place = { y: 500, height: 4000 };
    const stop = trackTextReadingPlace(() => ({ readingPlace: () => place }), () => note);
    expect(loadReadingPlace(note)).toBeNull();
    vi.advanceTimersByTime(READING_PLACE_EVERY_MS);
    expect(loadReadingPlace(note)).toEqual({ y: 500, height: 4000 });
    place = { y: 2600, height: 4000 };
    vi.advanceTimersByTime(READING_PLACE_EVERY_MS);
    expect(loadReadingPlace(note)).toEqual({ y: 2600, height: 4000 });
    // Under the content too, for the next launch's new id.
    expect(loadReadingPlace({ docId: "mdink-second", hash: note.hash })).toEqual({ y: 2600, height: 4000 });
    stop();
    place = { y: 3900, height: 4000 };
    vi.advanceTimersByTime(READING_PLACE_EVERY_MS * 3);
    expect(loadReadingPlace(note)).toEqual({ y: 2600, height: 4000 });
  });

  it("takes it at once when the app goes to the background", () => {
    const stop = trackTextReadingPlace(() => ({ readingPlace: () => ({ y: 77, height: 900 }) }), () => note);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(loadReadingPlace(note)).toEqual({ y: 77, height: 900 });
    stop();
  });

  it("writes nothing until the open has been back to the place, nor without a place", () => {
    saveReadingPlace(note, { y: 5541, height: 113753 });
    // A new launch's tab, still at the top of the note, not yet restored.
    let armed = false;
    const fresh = { docId: "mdink-second", hash: note.hash };
    const stop = trackTextReadingPlace(() => ({ readingPlace: () => ({ y: 0, height: 113754 }) }), () => (armed ? fresh : null));
    vi.advanceTimersByTime(READING_PLACE_EVERY_MS * 3);
    expect(loadReadingPlace(fresh)).toEqual({ y: 5541, height: 113753 });
    armed = true;
    vi.advanceTimersByTime(READING_PLACE_EVERY_MS);
    expect(loadReadingPlace(fresh)).toEqual({ y: 0, height: 113754 });
    stop();
    const stop2 = trackTextReadingPlace(() => ({ readingPlace: () => null }), () => ({ docId: "mdink-third", hash: "md-x" }));
    vi.advanceTimersByTime(READING_PLACE_EVERY_MS * 2);
    expect(loadReadingPlace({ docId: "mdink-third", hash: "md-x" })).toBeNull();
    stop2();
  });
});
