import { describe, expect, it } from "vitest";
import { newPinchTrack, pinchZoom, readingZoomCeiling, readingZoomSpan } from "./readingZoom";
const pages = Array.from({ length: 1000 }, (_, i) => ({ pageId: i + 1, minY: i * 820, maxY: i * 820 + 800 }));
describe("pinch page scope", () => {
  it("uses one page when reading inside it", () => {
    expect(readingZoomSpan(pages, 840, 1450, 1100)).toEqual({ minY: 820, maxY: 1620 });
  });
  it("keeps both pages when the viewport crosses their boundary", () => {
    expect(readingZoomSpan(pages, 1400, 1900, 1650)).toEqual({ minY: 820, maxY: 2440 });
  });
  it("never expands to a whole book when starting zoomed far out", () => {
    const span = readingZoomSpan(pages, 0, 800000, 410100)!;
    expect(span.maxY - span.minY).toBe(1620);
    expect(span.minY).toBeLessThanOrEqual(410100);
    expect(span.maxY).toBeGreaterThan(410100);
  });
  it("does not pull a neighbour into a viewport exactly on the page boundary", () => {
    expect(readingZoomSpan(pages, 820, 1620, 1100)).toEqual({ minY: 820, maxY: 1620 });
    expect(readingZoomSpan([], 0, 100, 50)).toBeNull();
  });
});
describe("pinch zoom range", () => {
  it("reaches three times the column's width fit in one pinch, whatever pages are visible", () => {
    // Two pages visible: their height fit is far below the width fit.
    expect(readingZoomCeiling(0.55, 1.68, 1.68, 3, 1.75)).toBeCloseTo(5.04);
    expect(readingZoomCeiling(0.9, 0.9, 0.9, 3, 1.75)).toBeCloseTo(2.7);
    expect(readingZoomCeiling(0.3, 0.3, 4, 3, 1.75)).toBe(4);
  });
});
describe("pinch gesture", () => {
  const at = (y = 500) => ({ x: 300, y });
  it("pans at the starting zoom inside the band, then zooms from where it left it", () => {
    const t = newPinchTrack(100, 1, at());
    expect(pinchZoom(t, 104, at(), 10, 1)).toBe(1);
    expect(pinchZoom(t, 110, at(), 20, 1)).toBe(1);
    expect(t.mode).toBe("zoom");
    expect(pinchZoom(t, 220, at(), 30, 1)).toBeCloseTo(2);
  });
  it("locks a two-finger pan at its zoom, whatever the spread wobbles", () => {
    const t = newPinchTrack(200, 1.5, at());
    let z = 1.5;
    for (let i = 1; i <= 40; i++) z = pinchZoom(t, 200 * (1 + 0.05 * Math.sin(i)), at(500 + i * 8), i * 16, z);
    expect(t.mode).toBe("pan");
    expect(z).toBe(1.5);
    expect(pinchZoom(t, 240, at(820), 700, z)).toBe(1.5);
    expect(t.mode).toBe("zoom");
  });
  it("hands a pinch that turns into a pan to panning without a pause", () => {
    const t = newPinchTrack(150, 1, at());
    let z = 1;
    for (let i = 1; i <= 15; i++) z = pinchZoom(t, 150 + 110 * i / 15, at(), i * 16, z);
    const reached = z;
    expect(reached).toBeGreaterThan(1.5);
    for (let i = 1; i <= 40; i++) z = pinchZoom(t, 260 * (1 + 0.04 * Math.sin(i / 3)), at(500 + 300 * i / 40), 240 + i * 16, z);
    expect(t.mode).toBe("pan");
    expect(Math.abs(z - reached)).toBeLessThan(0.08);
  });
  it("keeps zooming through a slow, continuous pinch", () => {
    const t = newPinchTrack(100, 1, at());
    let z = pinchZoom(t, 110, at(), 0, 1);
    for (let i = 1; i <= 40; i++) z = pinchZoom(t, 110 * (1 + i * 0.01), at(), i * 50, z);
    expect(t.mode).toBe("zoom");
    expect(z).toBeCloseTo(1.4);
  });
});
