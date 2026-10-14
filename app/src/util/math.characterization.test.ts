import { describe, expect, it } from "vitest";
import { clamp01 as colorClamp } from "../canvas/ColorSlotEditor";
import { clamp01 as meterClamp } from "../canvas/inkLoadMeter";
import { clamp as wheelClamp } from "../canvas/NumberWheel";
import { clamp as tipsClamp } from "../components/SmartTips";
import conflictSource from "../components/ConflictPagePreview.tsx?raw";
import { lerp as seedLerp } from "../canvas/inkLab/seedHop";
import { lerp as partialLerp } from "../canvas/partialEraser";
import { lerp as strokeLerp } from "../canvas/strokeEraser";
import { intersectBounds as exportIntersection } from "../canvas/exportPageComposite";
import { intersectBounds as tileIntersection } from "../canvas/inkLab/tilePaint";
import { intersectBounds as inkIntersection } from "../canvas/inkTiles";

// The component's nested copy has no export seam; execute its actual expression.
const conflictExpression = conflictSource.match(/const clamp = \(value: number, lo: number, hi: number\) => ([^;]+);/)![1];
const conflictClamp = new Function("value", "lo", "hi", `return ${conflictExpression}`) as (value: number, lo: number, hi: number) => number;
const numbers = [-Infinity, -10, -1, -0, 0, 0.25, 0.5, 1, 2, 10, Infinity, NaN];
const ranges = [[0, 1], [-1, 1], [1, 1], [2, -2], [-Infinity, Infinity], [NaN, 1], [0, NaN], [-0, 0]];
const boxes = [
  { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  { minX: 20, minY: 20, maxX: 30, maxY: 30 },
  { minX: 10, minY: 0, maxX: 20, maxY: 10 },
  { minX: 2, minY: 2, maxX: 4, maxY: 4 },
  { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  { minX: 10, minY: 10, maxX: 0, maxY: 0 },
  { minX: -0, minY: -0, maxX: 1, maxY: 1 },
  { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity },
  { minX: NaN, minY: 0, maxX: 1, maxY: 1 },
];

describe("math copies before extraction", () => {
  for (const [name, clamp] of [["ColorSlotEditor", colorClamp], ["inkLoadMeter", meterClamp]] as const) {
    it(`${name}: clamp01 grid`, () => {
      for (const value of numbers) expect(clamp(value)).toBe(Math.max(0, Math.min(1, value)));
    });
  }
  for (const [name, clamp] of [["NumberWheel", wheelClamp], ["SmartTips", tipsClamp], ["ConflictPagePreview", conflictClamp]] as const) {
    it(`${name}: generic clamp grid`, () => {
      for (const value of numbers) for (const [min, max] of ranges) {
        expect(clamp(value, min, max)).toBe(Math.min(max, Math.max(min, value)));
      }
    });
  }
  for (const [name, lerp] of [["seedHop", seedLerp], ["partialEraser", partialLerp], ["strokeEraser", strokeLerp]] as const) {
    it(`${name}: lerp grid`, () => {
      for (const a of numbers) for (const b of numbers) for (const t of numbers) {
        expect(lerp(a, b, t)).toBe(a + (b - a) * t);
      }
    });
  }
  for (const [name, intersect] of [["exportPageComposite", exportIntersection], ["tilePaint", tileIntersection], ["inkTiles", inkIntersection]] as const) {
    it(`${name}: intersection grid`, () => {
      for (const a of boxes) for (const b of boxes) {
        const minX = Math.max(a.minX, b.minX), minY = Math.max(a.minY, b.minY);
        const maxX = Math.min(a.maxX, b.maxX), maxY = Math.min(a.maxY, b.maxY);
        const expected = maxX <= minX || maxY <= minY ? null : { minX, minY, maxX, maxY };
        expect(intersect(a, b)).toEqual(expected);
      }
    });
  }
});
