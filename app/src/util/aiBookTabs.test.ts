import { describe, expect, it } from "vitest";

import { AI_TAB_WIDTH, AI_TAB_HEIGHT, BOOKTAB_EDGE_GAP, BOOKTAB_MIN_WIDTH, BOOKTAB_JITTER_GAP, BOOKTAB_JITTER_RISE, aiBookTabLeft, stackAiTabTops, edgeBookTabRects } from "./aiBookTabs";

describe("aiBookTabLeft", () => {
  it("hangs half the bookmark outside the left edge", () => {
    expect(aiBookTabLeft()).toBe(-14);
    expect(aiBookTabLeft(AI_TAB_WIDTH)).toBe(-AI_TAB_WIDTH / 2);
  });

  it("keeps half of a custom-width bookmark on the page", () => {
    expect(aiBookTabLeft(40)).toBe(-20);
  });
});

describe("stackAiTabTops", () => {
  it("keeps isolated tabs on their passage Y", () => {
    const tops = stackAiTabTops([
      { id: "a", y: 40 },
      { id: "b", y: 200 },
    ]);
    expect(tops.get("a")).toBe(40);
    expect(tops.get("b")).toBe(200);
  });

  it("pushes overlapping tabs apart so they stay hittable", () => {
    const tops = stackAiTabTops(
      [
        { id: "a", y: 40 },
        { id: "b", y: 45 },
      ],
      20,
    );
    expect(tops.get("a")).toBe(40);
    expect(tops.get("b")).toBe(60);
  });
});

describe("edgeBookTabRects", () => {
  const page = { left: 30, top: 100, width: 400, height: 600 };
  const tabs = [{ id: "third" }, { id: "first" }, { id: "second" }];
  it.each(["top", "bottom"] as const)("keeps order and equal gaps, half outside the %s edge", edge => {
    const layout = edgeBookTabRects(page, edge, tabs);
    expect([...layout.keys()]).toEqual(tabs.map(tab => tab.id));
    const rects = [...layout.values()];
    rects.forEach((rect, index) => {
      expect(rect.width).toBe(AI_TAB_HEIGHT);
      expect(rect.height).toBe(AI_TAB_WIDTH);
      expect(rect.top + rect.height / 2).toBe(edge === "top" ? page.top : page.top + page.height);
      expect(rect.left).toBe(page.left + BOOKTAB_EDGE_GAP + index * (AI_TAB_HEIGHT + BOOKTAB_EDGE_GAP));
    });
  });
  it.each(["top", "bottom"] as const)("shrinks crowded %s tabs evenly, then closes gaps at the minimum", edge => {
    for (const width of [180, 140, 128]) {
      const rects = [...edgeBookTabRects({ ...page, width }, edge,
        Array.from({ length: 10 }, (_, id) => ({ id: String(id) }))).values()];
      expect(rects[0]!.width).toBeLessThan(AI_TAB_HEIGHT);
      expect(rects[0]!.width).toBeGreaterThanOrEqual(BOOKTAB_MIN_WIDTH);
      rects.forEach((rect, index) => {
        expect(rect.width).toBe(rects[0]!.width);
        expect(rect.left + rect.width).toBeLessThanOrEqual(page.left + width);
        if (index) {
          expect(rect.left).toBeGreaterThanOrEqual(rects[index - 1]!.left + rects[index - 1]!.width);
          if (index > 1) expect(rect.left - rects[index - 1]!.left).toBeCloseTo(rects[1]!.left - rects[0]!.left);
        }
      });
    }
  });
  it("jitters spacing and height a little, stably, without overlap", () => {
    const many = Array.from({ length: 8 }, (_, id) => ({ id: `note-${id}` }));
    const a = [...edgeBookTabRects(page, "top", many, true).values()];
    const b = [...edgeBookTabRects(page, "top", many, true).values()];
    expect(a).toEqual(b);
    const steps = a.slice(1).map((rect, index) => rect.left - a[index]!.left);
    expect(new Set(steps.map(step => step.toFixed(3))).size).toBeGreaterThan(1);
    steps.forEach(step => {
      expect(step).toBeGreaterThanOrEqual(AI_TAB_HEIGHT + BOOKTAB_EDGE_GAP);
      expect(step).toBeLessThanOrEqual(AI_TAB_HEIGHT + BOOKTAB_EDGE_GAP + BOOKTAB_JITTER_GAP);
    });
    a.forEach(rect => expect(Math.abs(rect.top + rect.height / 2 - page.top)).toBeLessThanOrEqual(BOOKTAB_JITTER_RISE));
    expect(a[0]!.left).toBe(page.left + BOOKTAB_EDGE_GAP);
  });
  it("spends only spare room on jitter when the row is full", () => {
    const crowd = Array.from({ length: 10 }, (_, id) => ({ id: String(id) }));
    const rects = [...edgeBookTabRects({ ...page, width: 140 }, "bottom", crowd, true).values()];
    const last = rects.at(-1)!;
    expect(last.left + last.width).toBeLessThanOrEqual(page.left + 140);
    rects.slice(1).forEach((rect, index) => expect(rect.left).toBeGreaterThanOrEqual(rects[index]!.left + rects[index]!.width));
  });
  it("still fits without overlap when gapless minimum widths physically cannot fit", () => {
    const rects = [...edgeBookTabRects({ ...page, width: 80 }, "top",
      Array.from({ length: 20 }, (_, id) => ({ id: String(id) }))).values()];
    rects.forEach((rect, index) => {
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.left + rect.width).toBeLessThanOrEqual(page.left + 80);
      if (index) expect(rect.left).toBeGreaterThanOrEqual(rects[index - 1]!.left + rects[index - 1]!.width - 1e-10);
    });
  });
  it("handles no tabs and empty page boxes", () => {
    expect(edgeBookTabRects(page, "top", []).size).toBe(0);
    expect(edgeBookTabRects({ ...page, width: 0 }, "bottom", tabs).size).toBe(0);
  });
});
