import { describe, expect, it } from "vitest";

import { pageIndexAtLine, readingPlaceAt, readingPlaceLine, scrollYForLine, viewMiddleLine } from "./readingPlace";

const bounds = { minY: 100 };
// Text pages cut from a document whose top is at scene y 100.
const frames = [
  { pageId: 1, minY: 100, maxY: 480 },
  { pageId: 2, minY: 480, maxY: 900 },
  { pageId: 3, minY: 900, maxY: 1300 },
];

describe("readingPlaceAt", () => {
  it("is the held page's top in Pages reading, whatever the camera shows", () => {
    expect(readingPlaceAt({
      bounds, docHeight: 1200, held: frames[1]!, camera: { scrollY: -2000, zoom: 0.5 }, insetTop: 40,
    })).toEqual({ y: 380, height: 1200 });
  });

  it("is the line under the top chrome in scroll reading", () => {
    // View top at scene 600; 40 px of chrome at zoom 2 covers 20 units of it.
    expect(readingPlaceAt({
      bounds, docHeight: 1200, held: null, camera: { scrollY: -600, zoom: 2 }, insetTop: 40,
    })).toEqual({ y: 520, height: 1200 });
  });

  it("stays inside the document and waits for a height", () => {
    expect(readingPlaceAt({ bounds, docHeight: 1200, held: null, camera: { scrollY: 50, zoom: 1 }, insetTop: 0 }))
      .toEqual({ y: 0, height: 1200 });
    expect(readingPlaceAt({ bounds, docHeight: 0, held: frames[0]!, camera: null, insetTop: 0 })).toBeNull();
    expect(readingPlaceAt({ bounds, docHeight: 1200, held: null, camera: null, insetTop: 0 })).toBeNull();
  });
});

describe("going back to a place", () => {
  it("puts the line at the same share of a document that changed height", () => {
    expect(readingPlaceLine({ y: 380, height: 1200 }, bounds, 1200)).toBe(480);
    expect(readingPlaceLine({ y: 300, height: 1200 }, bounds, 2400)).toBe(700);
    expect(readingPlaceLine({ y: 5000, height: 1200 }, bounds, 1200)).toBe(1300);
  });

  it("scrolls the line to just under the top chrome", () => {
    const scrollY = scrollYForLine(620, 2, 40);
    expect(readingPlaceAt({ bounds, docHeight: 1200, held: null, camera: { scrollY, zoom: 2 }, insetTop: 40 }))
      .toEqual({ y: 520, height: 1200 });
  });

  it("holds the page the line falls on, and a held page's own top keeps that page", () => {
    expect(pageIndexAtLine(frames, 480)).toBe(1);
    expect(pageIndexAtLine(frames, 479.8)).toBe(1);
    expect(pageIndexAtLine(frames, 700)).toBe(1);
    expect(pageIndexAtLine(frames, 100)).toBe(0);
    expect(pageIndexAtLine(frames, 99999)).toBe(2);
    expect(pageIndexAtLine([], 10)).toBe(-1);
  });

  it("reads a saved camera's page from the middle of its view", () => {
    // A page fit centres the page: zoom 0.5, 900 px tall, page 2 in the middle.
    expect(pageIndexAtLine(frames, viewMiddleLine({ scrollY: -(690 - 900), zoom: 0.5 }, 900))).toBe(1);
  });
});
