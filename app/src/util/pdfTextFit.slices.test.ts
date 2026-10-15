/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { alignTextLayerToGlyphs, alignTextLayerToGlyphsInSlices, type PdfTextItem } from "./pdfTextFit";

/** A page whose layout and screen widths match, and spans with a fixed measured width. */
function fixture(count: number) {
  const page = document.createElement("div");
  Object.defineProperty(page, "offsetWidth", { value: 600 });
  page.getBoundingClientRect = () => ({ width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
  document.body.append(page);
  const spans: HTMLElement[] = [];
  const items: PdfTextItem[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 7 === 3) items.push({ type: "beginMarkedContent" });
    const span = document.createElement("span");
    span.style.setProperty("--scale-x", "1");
    const measured = 50 + (i % 5) * 3;
    span.getBoundingClientRect = () => ({ width: measured, height: 10, top: 0, left: 0, right: measured, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
    page.append(span);
    spans.push(span);
    items.push({ str: `word ${i}`, width: 50 + (i % 9) });
  }
  return { page, spans, items, scales: () => spans.map((span) => span.style.getPropertyValue("--scale-x")) };
}

describe("alignTextLayerToGlyphsInSlices", () => {
  it("fits exactly like the one-pass fit, pausing between slices", async () => {
    const once = fixture(1000);
    const changedOnce = alignTextLayerToGlyphs(once.page, once.spans, once.items, 1);
    document.body.textContent = "";
    const sliced = fixture(1000);
    let pauses = 0;
    const changedSliced = await alignTextLayerToGlyphsInSlices(sliced.page, sliced.spans, sliced.items, 1, async () => { pauses += 1; }, () => false, 250);
    expect(changedSliced).toBe(changedOnce);
    expect(sliced.scales()).toEqual(once.scales());
    expect(pauses).toBe(3);
  });

  it("stops when the page goes away mid-fit", async () => {
    const { page, spans, items, scales } = fixture(1000);
    let gone = false;
    await alignTextLayerToGlyphsInSlices(page, spans, items, 1, async () => { gone = true; }, () => gone, 250);
    expect(scales().slice(250).every((scale) => scale === "1")).toBe(true);
  });
});
