/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOKTABS_EVENT, loadShowBooktabs, saveShowBooktabs, loadBooktabPosition, saveBooktabPosition, loadBooktabFootnotes, saveBooktabFootnotes } from "./booktabsPref";

beforeEach(() => localStorage.clear());
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
describe("booktab preferences", () => {
  it("defaults to today's ChatBot tabs beside the passage", () => {
    expect(loadShowBooktabs()).toBe(true);
    expect(loadBooktabPosition()).toBe("beside");
    expect(loadBooktabFootnotes()).toBe("chatbot");
  });
  it("round trips every choice and announces each save", () => {
    const changed = vi.fn();
    window.addEventListener(BOOKTABS_EVENT, changed);
    try {
      for (const show of [false, true]) { saveShowBooktabs(show); expect(loadShowBooktabs()).toBe(show); }
      for (const position of ["beside", "top", "bottom"] as const) { saveBooktabPosition(position); expect(loadBooktabPosition()).toBe(position); }
      for (const footnotes of ["all", "chatbot"] as const) { saveBooktabFootnotes(footnotes); expect(loadBooktabFootnotes()).toBe(footnotes); }
      expect(changed).toHaveBeenCalledTimes(7);
    } finally { window.removeEventListener(BOOKTABS_EVENT, changed); }
  });
  it.each(["garbage", "", "null", "NaN"])("falls back for garbage %j", value => {
    for (const key of ["show", "position", "footnotes"]) localStorage.setItem(`whiteboard.booktabs.${key}.v1`, value);
    expect(loadShowBooktabs()).toBe(true);
    expect(loadBooktabPosition()).toBe("beside");
    expect(loadBooktabFootnotes()).toBe("chatbot");
  });
  it("tolerates unavailable storage and still announces writes", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    expect(loadShowBooktabs()).toBe(true);
    expect(loadBooktabPosition()).toBe("beside");
    expect(loadBooktabFootnotes()).toBe("chatbot");
    expect(() => { saveShowBooktabs(false); saveBooktabPosition("top"); saveBooktabFootnotes("all"); }).not.toThrow();
  });
});
