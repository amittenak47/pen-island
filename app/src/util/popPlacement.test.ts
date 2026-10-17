import { expect, it } from "vitest";

import { popPlacement } from "./popPlacement";

const button = (left: number, top: number, size = 22) => ({ left, top, right: left + size, bottom: top + size });
const pop = { width: 280, height: 60 };

it("sits under the button with their left edges lined up", () => {
  expect(popPlacement(button(100, 40), pop, { width: 1200, height: 800 })).toEqual({ top: 70, left: 100, above: false });
});

it("lines up right edges for a button near the right side of the window", () => {
  const placed = popPlacement(button(1160, 40), pop, { width: 1200, height: 800 });
  expect(placed.left).toBe(1182 - 280);
  expect(placed.left + pop.width).toBeLessThanOrEqual(1200 - 8);
});

it("flips above when there is no room below", () => {
  expect(popPlacement(button(100, 760), pop, { width: 1200, height: 800 })).toEqual({ top: 760 - 8 - 60, left: 100, above: true });
});

it("stays inside a phone-width window even when wider than the space beside the button", () => {
  const placed = popPlacement(button(300, 40), pop, { width: 360, height: 640 });
  expect(placed.left).toBeGreaterThanOrEqual(8);
  expect(placed.left + pop.width).toBeLessThanOrEqual(360 - 8);
});

it("keeps a tall notification on screen when neither side fits", () => {
  const placed = popPlacement(button(100, 300), { width: 280, height: 600 }, { width: 1200, height: 640 });
  expect(placed.top).toBeGreaterThanOrEqual(8);
  expect(placed.top + 600).toBeLessThanOrEqual(640 - 8);
});
