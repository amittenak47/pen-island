import { describe, expect, it } from "vitest";

import { jumpLandsOnFittedLock } from "./fittedLock";

describe("a jump to the page the lock just fitted", () => {
  const lock = { minY: 1200, maxY: 1800 };

  it("needs nothing moved when it lands within that page", () => {
    expect(jumpLandsOnFittedLock(lock, lock, true, 1200)).toBe(true);
    // Where a hand zoomed into the page had it.
    expect(jumpLandsOnFittedLock(lock, lock, true, 1500)).toBe(true);
  });

  it("moves the camera for another page, a lock set since, no lock fitted, or no page fit", () => {
    expect(jumpLandsOnFittedLock(lock, lock, true, 1800)).toBe(false);
    expect(jumpLandsOnFittedLock(lock, lock, true, 600)).toBe(false);
    expect(jumpLandsOnFittedLock(lock, { ...lock }, true, 1200)).toBe(false);
    expect(jumpLandsOnFittedLock(null, lock, true, 1200)).toBe(false);
    expect(jumpLandsOnFittedLock(lock, lock, false, 1200)).toBe(false);
  });
});
