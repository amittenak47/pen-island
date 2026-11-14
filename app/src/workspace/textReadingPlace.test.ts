/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadReadingPlace, saveReadingPlace } from "../util/readingPosition";
import { keepsReadingPlace, READING_PLACE_EVERY_MS, restoreTextReadingPlace, trackTextReadingPlace } from "./textReadingPlace";

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
    saveReadingPlace("note", { y: 8420, height: 113574 });
    const board = { goToReadingPlace: vi.fn(() => true) };
    expect(restoreTextReadingPlace(board, "note", 0)).toEqual({ y: 8420, height: 113574 });
    expect(board.goToReadingPlace).toHaveBeenCalledWith({ y: 8420, height: 113574 });
  });

  it("leaves a session saved after the reading on its own camera", () => {
    saveReadingPlace("note", { y: 8420, height: 113574 });
    const board = { goToReadingPlace: vi.fn(() => true) };
    expect(restoreTextReadingPlace(board, "note", 200_000)).toBeNull();
    expect(board.goToReadingPlace).not.toHaveBeenCalled();
  });

  it("says nothing was restored when the board could not go there", () => {
    saveReadingPlace("note", { y: 10, height: 100 });
    expect(restoreTextReadingPlace({ goToReadingPlace: () => false }, "note", 0)).toBeNull();
    expect(restoreTextReadingPlace(null, "note", 0)).toBeNull();
    expect(restoreTextReadingPlace({ goToReadingPlace: () => true }, "other", 0)).toBeNull();
  });
});

describe("trackTextReadingPlace", () => {
  it("takes the place every second while the document is read, and stops", () => {
    let place = { y: 500, height: 4000 };
    const stop = trackTextReadingPlace(() => ({ readingPlace: () => place }), () => "note");
    expect(loadReadingPlace("note")).toBeNull();
    vi.advanceTimersByTime(READING_PLACE_EVERY_MS);
    expect(loadReadingPlace("note")).toEqual({ y: 500, height: 4000 });
    place = { y: 2600, height: 4000 };
    vi.advanceTimersByTime(READING_PLACE_EVERY_MS);
    expect(loadReadingPlace("note")).toEqual({ y: 2600, height: 4000 });
    stop();
    place = { y: 3900, height: 4000 };
    vi.advanceTimersByTime(READING_PLACE_EVERY_MS * 3);
    expect(loadReadingPlace("note")).toEqual({ y: 2600, height: 4000 });
  });

  it("takes it at once when the app goes to the background", () => {
    const stop = trackTextReadingPlace(() => ({ readingPlace: () => ({ y: 77, height: 900 }) }), () => "note");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(loadReadingPlace("note")).toEqual({ y: 77, height: 900 });
    stop();
  });

  it("writes nothing without a document or a place", () => {
    const stop = trackTextReadingPlace(() => ({ readingPlace: () => null }), () => "note");
    const stop2 = trackTextReadingPlace(() => ({ readingPlace: () => ({ y: 1, height: 2 }) }), () => null);
    vi.advanceTimersByTime(READING_PLACE_EVERY_MS * 2);
    expect(loadReadingPlace("note")).toBeNull();
    stop();
    stop2();
  });
});
