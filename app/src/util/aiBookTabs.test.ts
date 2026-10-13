import { describe, expect, it } from "vitest";

import { AI_TAB_WIDTH, aiBookTabLeft, stackAiTabTops } from "./aiBookTabs";

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
