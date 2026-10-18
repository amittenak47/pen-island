/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import { alignTextLayerToGlyphs, refitScaleX, spannedItems } from "./pdfTextFit";

afterEach(() => { document.body.replaceChildren(); });

function layer(ratios: number[]) {
  const page = document.createElement("div");
  document.body.append(page);
  Object.defineProperty(page, "offsetWidth", { value: 400 });
  page.getBoundingClientRect = () => new DOMRect(0, 0, 800, 1200);
  const items = ratios.map((_, i) => ({ str: `Words ${i}`, width: 100 + i, fontName: "body" }));
  const spans = ratios.map((ratio, i) => {
    const span = document.createElement("span");
    span.style.setProperty("--scale-x", String(1 + i / 100));
    span.getBoundingClientRect = vi.fn(() => new DOMRect(0, 0, items[i].width * 2 / ratio, 20));
    page.append(span);
    return span;
  });
  return { page, spans, items };
}

describe("alignTextLayerToGlyphs", () => {
  it("fits uniform text zoom at the camera scale, preserving each starting scale", () => {
    const { page, spans, items } = layer(Array(24).fill(1 / 0.85));
    expect(alignTextLayerToGlyphs(page, spans, items, 1)).toBe(24);
    for (const [i, span] of spans.entries()) {
      expect(Number(span.style.getPropertyValue("--scale-x"))).toBeCloseTo((1 + i / 100) / 0.85, 10);
    }
    expect(spans.reduce((n, span) => n + vi.mocked(span.getBoundingClientRect).mock.calls.length, 0)).toBe(8);
  });

  it("fits mixed scaling per span and leaves matching, invalid and rotated boxes alone", () => {
    const ratios = [1 / 0.85, 0.8, 1.004, Infinity, 1.2];
    const { page, spans, items } = layer(ratios);
    spans[4].style.setProperty("--rotate", "90deg");
    expect(alignTextLayerToGlyphs(page, spans, items, 1)).toBe(2);
    expect(Number(spans[0].style.getPropertyValue("--scale-x"))).toBeCloseTo(1 / 0.85, 10);
    expect(Number(spans[1].style.getPropertyValue("--scale-x"))).toBeCloseTo(1.01 * 0.8, 10);
    expect(spans.slice(2).map(span => span.style.getPropertyValue("--scale-x"))).toEqual(["1.02", "1.03", "1.04"]);
  });

  it("falls back for the whole mixed font, while sampling other fonts independently", () => {
    const ratios = Array(32).fill(1 / 0.85) as number[];
    ratios[3] = 0.8;
    ratios.fill(1.25, 24);
    const { page, spans, items } = layer(ratios);
    for (let i = 24; i < items.length; i += 1) items[i].fontName = "heading";
    expect(alignTextLayerToGlyphs(page, spans, items, 1)).toBe(32);
    for (const [i, span] of spans.entries()) {
      expect(Number(span.style.getPropertyValue("--scale-x"))).toBeCloseTo((1 + i / 100) * ratios[i], 10);
      expect(span.getBoundingClientRect).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the existing tolerance and scale bounds on the sampled path", () => {
    const { page, spans, items } = layer(Array(24).fill(1.004));
    expect(alignTextLayerToGlyphs(page, spans, items, 1)).toBe(0);
    spans[1].style.setProperty("--scale-x", "19");
    for (const [i, span] of spans.entries()) {
      vi.mocked(span.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, items[i].width, 20));
    }
    expect(alignTextLayerToGlyphs(page, spans, items, 1)).toBe(23);
    expect(spans[1].style.getPropertyValue("--scale-x")).toBe("19");
  });
});

describe("refitScaleX", () => {
  it("leaves a span that already covers its glyphs alone", () => {
    expect(refitScaleX({ want: 200, measured: 200, scaleX: 1.1 })).toBeNull();
    // Sub-pixel metrics never land exactly; half a percent is the same width.
    expect(refitScaleX({ want: 200, measured: 200.4, scaleX: 1 })).toBeNull();
  });

  it("stretches a span the WebView laid out short", () => {
    // Android's system font size reaches the WebView as a text zoom: the DOM
    // string comes out at 85% while the canvas pdf.js measured stays at 100%.
    const next = refitScaleX({ want: 726, measured: 617.1, scaleX: 1.1 });
    expect(next).toBeCloseTo(1.1 / 0.85, 3);
  });

  it("shrinks a span laid out long", () => {
    expect(refitScaleX({ want: 100, measured: 125, scaleX: 1 })).toBeCloseTo(0.8, 5);
  });

  it("keeps out of the way of a span with nothing to measure", () => {
    // A span that has not been laid out reports zero, and a page mid-paint is
    // late rather than wrong — dividing by it would stamp a garbage transform.
    expect(refitScaleX({ want: 200, measured: 0, scaleX: 1 })).toBeNull();
    expect(refitScaleX({ want: 0, measured: 200, scaleX: 1 })).toBeNull();
    expect(refitScaleX({ want: 200, measured: Number.NaN, scaleX: 1 })).toBeNull();
  });

  it("refuses a correction too large to have come from a measurement", () => {
    expect(refitScaleX({ want: 4000, measured: 0.01, scaleX: 1 })).toBeNull();
    expect(refitScaleX({ want: 0.01, measured: 4000, scaleX: 1 })).toBeNull();
  });
});

describe("spannedItems", () => {
  it("drops the marked-content markers so spans and items line up", () => {
    const items = [
      { type: "beginMarkedContent" },
      { str: "Two ideas changed the world.", width: 726 },
      { type: "endMarkedContent" },
      { str: "", width: 0 },
      { str: "In 1448", width: 120 },
    ];
    expect(spannedItems(items).map((item) => item.str)).toEqual([
      "Two ideas changed the world.",
      "",
      "In 1448",
    ]);
  });
});
