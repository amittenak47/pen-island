import { describe, expect, it } from "vitest";
import { InkPageBook } from "./inkPageCache";
import { encodeInkOps } from "./inkCodec";
import { type InkDrawOp, type InkEraseOp } from "./rasterInk";
import { contentBottomInFrame, growDrawHeight } from "../templates/drawPageGrowth";

const frame = { x: 100, y: 200, width: 400, height: 1500 };
const stroke = (...pairs: [number, number][]): InkDrawOp => ({
  kind: "draw", color: "#111", baseWidth: 40, maxFullness: 1,
  pressureClip: 1, pressureSensitive: false,
  points: pairs.map(([x, y]) => ({ x, y, pressure: .5 })),
});
const erase = (y: number): InkEraseOp => ({
  kind: "erase", radius: 30, points: [{ x: 300, y, pressure: .5 }],
});
const height = (book: InkPageBook, currentH = 1500) => growDrawHeight({
  basePageH: 1000, currentH, contentBottomRel: book.drawContentBottom(frame, 0),
});

describe("draw frame growth decisions", () => {
  it.each([
    [1199, 1200, 1000, 1500],
    [1199, 1200.1, 1000.1, 2000],
    [1200, 1200, 1001, 2000],
    [1699, 1700, 1500, 2000],
    [1699, 1700.1, 1500.1, 2500],
    [5199, 5200, 5000, 5000],
  ])("keeps the strict buffer threshold for y=%s..%s", (top, bottom, measured, expected) => {
    const book = new InkPageBook();
    book.commit(stroke([300, top], [300, bottom]));
    expect(book.drawContentBottom(frame, 0)).toBeCloseTo(measured);
    expect(height(book)).toBe(expected);
  });

  it("filters individual points of a stroke crossing another region", () => {
    const book = new InkPageBook();
    book.commit(stroke([100, 900], [500, 1200], [501, 4000], [99, 5000]));
    expect(book.drawContentBottom(frame, 0)).toBe(1000);
    expect(height(book)).toBe(1500);
    expect(book.drawContentBottom({ ...frame, x: 501 }, 0)).toBe(3801);
  });

  it("includes the header edge, excludes points above it and does not clip height", () => {
    const book = new InkPageBook();
    book.commit(stroke([300, 249.9], [99, 5000]));
    expect(book.drawContentBottom(frame, 50)).toBe(50);
    book.commit(stroke([300, 250]));
    expect(book.drawContentBottom(frame, 50)).toBe(51);
    book.commit(stroke([300, 2600], [300, 2700]));
    expect(book.drawContentBottom(frame, 50)).toBe(2500);
    expect(height(book)).toBe(3000);
  });

  it("keeps element measurement separate from ink and template chrome", () => {
    const book = new InkPageBook();
    book.commit(stroke([300, 900], [300, 1000]));
    const elements = [
      { x: 300, y: 1250, width: 10, height: 50 },
      { x: 300, y: 1500, width: 10, height: 50, customData: { lcPinnedHeader: true } },
    ];
    const bottom = Math.max(book.drawContentBottom(frame, 0), contentBottomInFrame(elements, [], frame, 0, false));
    expect(bottom).toBe(1100);
    expect(growDrawHeight({ basePageH: 1000, currentH: 1500, contentBottomRel: bottom })).toBe(2000);
  });

  it("shrinks measured content after undo and stroke erase while retaining the grown frame", () => {
    const book = new InkPageBook();
    book.commit(stroke([300, 900], [300, 1000]));
    book.commit(stroke([300, 1400], [300, 1500]));
    expect(book.drawContentBottom(frame, 0)).toBe(1300);
    expect(height(book)).toBe(2000);
    book.undoOnce();
    expect(book.drawContentBottom(frame, 0)).toBe(800);
    expect(height(book, 2000)).toBe(2000);
    book.redoOnce();
    expect(book.drawContentBottom(frame, 0)).toBe(1300);
    expect(book.strokeErase(erase(1500))).not.toBeNull();
    expect(book.drawContentBottom(frame, 0)).toBe(800);
    book.undoOnce();
    expect(book.drawContentBottom(frame, 0)).toBe(1300);
    book.redoOnce();
    expect(book.drawContentBottom(frame, 0)).toBe(800);
  });

  it("shrinks measured content after partial erase and restores it on undo", () => {
    const book = new InkPageBook();
    book.commit(stroke([300, 900], [300, 1500]));
    const before = book.drawContentBottom(frame, 0);
    expect(book.partialErase(erase(1500))).not.toBeNull();
    expect(book.drawContentBottom(frame, 0)).toBeLessThan(before);
    expect(height(book, 2000)).toBe(2000);
    book.undoOnce();
    expect(book.drawContentBottom(frame, 0)).toBe(before);
  });

  it("counts ink on cold pages that have never entered the paint window", () => {
    const book = new InkPageBook();
    const cold = encodeInkOps([stroke([300, 2299], [300, 2300])]);
    book.ingestEncodedPages(new Map([[20, cold]]));
    expect(book.hot.has(20)).toBe(false);
    expect(book.drawContentBottom(frame, 0)).toBe(2100);
    expect(height(book)).toBe(3000);
    expect(book.hot.has(20)).toBe(false);
    book.clear();
    expect(book.drawContentBottom(frame, 0)).toBe(0);
    book.undoOnce();
    expect(book.drawContentBottom(frame, 0)).toBe(2100);
  });
});
