import { describe, expect, it } from "vitest";
import { PAGE_LAYER_WILL_CHANGE, pageLayerWillChange } from "./pageLayerHint";

describe("pageLayerWillChange", () => {
  it("rides a pan as a layer of its own and lets go at rest, when nothing holds it", () => {
    expect(pageLayerWillChange(true, null, 0.55)).toBe("transform");
    expect(pageLayerWillChange(false, null, 0.55)).toBe("");
  });

  it("keeps the page's layers ready for a turn while held, moving or at rest", () => {
    expect(pageLayerWillChange(true, 0.55, 0.55)).toBe(PAGE_LAYER_WILL_CHANGE);
    expect(pageLayerWillChange(false, 0.55, 0.55)).toBe(PAGE_LAYER_WILL_CHANGE);
  });

  it("lets go of a hold taken at another zoom, so the page is drawn sharp at this one", () => {
    expect(pageLayerWillChange(false, 0.55, 0.8)).toBe("");
    expect(pageLayerWillChange(true, 0.55, 0.8)).toBe("transform");
    // Back at the zoom it was held at: held again.
    expect(pageLayerWillChange(false, 0.55, 0.55 * (1 + 1e-6))).toBe(PAGE_LAYER_WILL_CHANGE);
  });
});
