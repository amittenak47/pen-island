/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadReadingPage, loadReadingPlace, saveReadingPage, saveReadingPlace } from "./readingPosition";

describe("readingPosition", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    });
  });

  it("brings back the page a document was last read at", () => {
    expect(loadReadingPage("doc-1")).toBe(0);
    saveReadingPage("doc-1", 67);
    saveReadingPage("doc-2", 3);
    expect(loadReadingPage("doc-1")).toBe(67);
    expect(loadReadingPage("doc-2")).toBe(3);
  });

  it("leaves the page to a session saved after the reading", () => {
    saveReadingPage("doc-1", 67);
    expect(loadReadingPage("doc-1", Date.now() - 60_000)).toBe(67);
    expect(loadReadingPage("doc-1", Date.now() + 60_000)).toBe(0);
  });

  it("ignores a missing document or a page before the first", () => {
    saveReadingPage(null, 5);
    saveReadingPage("doc-1", 0);
    expect(loadReadingPage("doc-1")).toBe(0);
    expect(loadReadingPage(undefined)).toBe(0);
  });

  describe("text documents", () => {
    afterEach(() => vi.useRealTimers());

    it("brings back the place a note was last read at, apart from PDF pages", () => {
      expect(loadReadingPlace("note-1")).toBeNull();
      saveReadingPlace("note-1", { y: 8420, height: 113574 });
      saveReadingPage("note-1", 4);
      expect(loadReadingPlace("note-1")).toEqual({ y: 8420, height: 113574 });
      expect(loadReadingPage("note-1")).toBe(4);
    });

    it("leaves the place to a session saved after the reading", () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      saveReadingPlace("note-1", { y: 900, height: 5000 });
      expect(loadReadingPlace("note-1", 9_000)).toEqual({ y: 900, height: 5000 });
      expect(loadReadingPlace("note-1", 11_000)).toBeNull();
    });

    it("does not count a nudge as a newer reading", () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      saveReadingPlace("note-1", { y: 900, height: 5000 });
      vi.setSystemTime(20_000);
      saveReadingPlace("note-1", { y: 901, height: 5000 });
      expect(loadReadingPlace("note-1", 15_000)).toBeNull();
      saveReadingPlace("note-1", { y: 1400, height: 5000 });
      expect(loadReadingPlace("note-1", 15_000)).toEqual({ y: 1400, height: 5000 });
    });

    it("finds the place by content for a set that has none of its own", () => {
      saveReadingPlace({ docId: "launch-1", hash: "md-h" }, { y: 5541, height: 113753 });
      expect(loadReadingPlace({ docId: "launch-2", hash: "md-h" })).toEqual({ y: 5541, height: 113753 });
      expect(loadReadingPlace({ docId: "launch-2", hash: "md-other" })).toBeNull();
      expect(loadReadingPlace("launch-2")).toBeNull();
    });

    it("keeps each annotation set of one file on its own place", () => {
      saveReadingPlace({ docId: "set-a", hash: "md-h" }, { y: 900, height: 5000 });
      saveReadingPlace({ docId: "set-b", hash: "md-h" }, { y: 3000, height: 5000 });
      expect(loadReadingPlace({ docId: "set-a", hash: "md-h" })).toEqual({ y: 900, height: 5000 });
      expect(loadReadingPlace({ docId: "set-new", hash: "md-h" })).toEqual({ y: 3000, height: 5000 });
    });

    it("leaves a content place older than the session to the session", () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      saveReadingPlace({ docId: "launch-1", hash: "md-h" }, { y: 900, height: 5000 });
      expect(loadReadingPlace({ docId: "launch-2", hash: "md-h" }, 11_000)).toBeNull();
    });

    it("ignores a missing document or a place it cannot use", () => {
      saveReadingPlace(null, { y: 10, height: 100 });
      saveReadingPlace("note-1", { y: -5, height: 100 });
      saveReadingPlace("note-1", { y: 10, height: 0 });
      saveReadingPlace("note-1", null);
      expect(loadReadingPlace("note-1")).toBeNull();
      expect(loadReadingPlace(undefined)).toBeNull();
    });
  });
});
