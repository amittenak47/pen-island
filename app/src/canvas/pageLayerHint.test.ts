import { describe, expect, it } from "vitest";
import { PAGE_LAYER_WILL_CHANGE, pageLayerWillChange, scrollRestHold } from "./pageLayerHint";

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

describe("scrollRestHold", () => {
  it("keeps a scroll reader's page layers ready between flings, at a zoom the page has rested at before", () => {
    // The first rest at this zoom: nothing held, the page drawn sharp as it rests.
    expect(scrollRestHold(null, 1.09)).toBeNull();
    expect(pageLayerWillChange(false, null, 1.09)).toBe("");
    // A fling rides a layer, and at its rest, at the same zoom, the layers are held...
    expect(pageLayerWillChange(true, null, 1.09)).toBe("transform");
    const held = scrollRestHold(1.09, 1.09);
    expect(held).toBe(1.09);
    expect(pageLayerWillChange(false, held, 1.09)).toBe(PAGE_LAYER_WILL_CHANGE);
    // ...so the next fling starts on them as they are: nothing to promote and paint again.
    expect(pageLayerWillChange(true, held, 1.09)).toBe(PAGE_LAYER_WILL_CHANGE);
  });

  it("lets a pinch's new zoom rest once unheld, so the page is drawn sharp at it, then holds it", () => {
    expect(scrollRestHold(1.09, 1.5)).toBeNull();
    expect(pageLayerWillChange(false, null, 1.5)).toBe("");
    expect(scrollRestHold(1.5, 1.5 * (1 + 1e-6))).toBe(1.5 * (1 + 1e-6));
  });
});
