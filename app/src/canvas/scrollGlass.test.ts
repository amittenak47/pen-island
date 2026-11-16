/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { lowerScrollGlass, raiseScrollGlass } from "./scrollGlass";

function board() {
  const el = document.createElement("div");
  el.className = "lc-board";
  const text = document.createElement("div");
  text.className = "lc-page-content-slot";
  el.append(text);
  return { el, text };
}

describe("glass over the text while scroll reading moves the page", () => {
  it("lies over the text while the page moves and comes off when it rests, left in place off", () => {
    const { el, text } = board();
    raiseScrollGlass(el, text);
    expect(el.dataset.scrollGlass).toBe("on");
    lowerScrollGlass(el);
    // Off but still there: raising it again is a style change, not a new box.
    expect(el.dataset.scrollGlass).toBe("");
    expect(el.hasAttribute("data-scroll-glass")).toBe(true);
  });

  it("is never up while the text is being marked or edited", () => {
    const { el, text } = board();
    el.classList.add("lc-board-highlighting");
    raiseScrollGlass(el, text);
    expect(el.dataset.scrollGlass).toBeUndefined();
    el.classList.remove("lc-board-highlighting");
    text.classList.add("lc-page-content-editing");
    raiseScrollGlass(el, text);
    expect(el.dataset.scrollGlass).toBeUndefined();
  });

  it("needs a page of text to lie over", () => {
    const { el } = board();
    raiseScrollGlass(el, null);
    expect(el.dataset.scrollGlass).toBeUndefined();
    expect(() => lowerScrollGlass(null)).not.toThrow();
  });
});
