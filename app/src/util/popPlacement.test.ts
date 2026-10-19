import { expect, it } from "vitest";

import { popPlacement } from "./popPlacement";

const button = (left: number, top: number, size = 22) => ({ left, top, right: left + size, bottom: top + size });
const pop = { width: 280, height: 60 };

it("sits under the button with their left edges lined up", () => {
  expect(popPlacement(button(100, 40), pop, { width: 1200, height: 800 })).toMatchObject({ top: 70, left: 100, above: false });
});

it("lines up right edges for a button near the right side of the window", () => {
  const placed = popPlacement(button(1160, 40), pop, { width: 1200, height: 800 });
  expect(placed.left).toBe(1182 - 280);
  expect(placed.left + pop.width).toBeLessThanOrEqual(1200 - 8);
});

it("flips above when there is no room below", () => {
  expect(popPlacement(button(100, 760), pop, { width: 1200, height: 800 })).toMatchObject({ top: 760 - 8 - 60, left: 100, above: true });
});

it("stays inside a phone-width window even when wider than the space beside the button", () => {
  const placed = popPlacement(button(300, 40), pop, { width: 360, height: 640 });
  expect(placed.left).toBeGreaterThanOrEqual(8);
  expect(placed.left + pop.width).toBeLessThanOrEqual(360 - 8);
});

it("a notification too tall for either side takes the roomier one, never covering its button", () => {
  // 284 px above the button, 302 below: below, capped there (it scrolls inside).
  const placed = popPlacement(button(100, 300), { width: 280, height: 600 }, { width: 1200, height: 640 });
  expect(placed).toMatchObject({ top: 330, above: false, maxHeight: 302 });
  const high = popPlacement(button(100, 400), { width: 280, height: 600 }, { width: 1200, height: 640 });
  expect(high).toMatchObject({ top: 8, above: true, maxHeight: 384 });
});

it("a kept side whose content grew past the room there is capped, not moved", () => {
  // Home's sync list opening under the icon: it stays under the icon.
  const placed = popPlacement(button(100, 200), { width: 280, height: 700 }, { width: 1200, height: 800 }, 8, 8, "below", "below");
  expect(placed).toMatchObject({ top: 230, above: false, maxHeight: 562 });
  const up = popPlacement(button(100, 200), { width: 280, height: 700 }, { width: 1200, height: 800 }, 8, 8, "above", "above");
  expect(up).toMatchObject({ top: 8, above: true, maxHeight: 184 });
});

it("opens above when asked to, and falls back below when the top of the window is too close", () => {
  expect(popPlacement(button(100, 200), pop, { width: 1200, height: 800 }, 8, 8, "above")).toMatchObject({ top: 200 - 8 - 60, left: 100, above: true });
  expect(popPlacement(button(100, 20), pop, { width: 1200, height: 800 }, 8, 8, "above").above).toBe(false);
});

it("keeps a side it was given even when the other would now fit", () => {
  expect(popPlacement(button(100, 200), pop, { width: 1200, height: 800 }, 8, 8, "above", "below")).toMatchObject({ top: 230, left: 100, above: false });
});
