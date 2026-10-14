import { describe, expect, it, vi } from "vitest";

import { NO_PRESSURE, type InkDrawOp, type InkOp } from "../canvas/rasterInk";
import { conflictPdfFrames } from "../components/conflictDocumentLayout";
import type { PdfPageSize } from "../modes/pdfPageSizeCache";
import { convertPdfInkOps, inferPdfInkLayout, localizeHubInkDto, sourcePdfInkLayout } from "./pdfInkLayout";
import { decodeInkOps, encodeInkOps, packEncodedInk, unpackEncodedInk } from "../canvas/inkCodec";
import { b64ToBytes, bytesToB64 } from "../api/nativeHttp";
import { bytesFromMaybeGzip } from "./gzip";
import { locatePdfInkPoint } from "../modes/pdfInkSpread";
import { desktopLayout, mixedPdfSizes, pdfPoint, pdfSizes, pdfStroke, storedPdfOps, tabletLayout } from "./testPdfInk";

const sizes: PdfPageSize[] = Array.from({ length: 40 }, (_, i) => ({ pageNumber: i + 1, width: 531, height: 666 }));
const tablet = { w: 642, spread: false };
const desktop = { w: 760, spread: false };
const split = { w: 642, spread: true };

/** A stroke across the middle of `sheet` in `layout`, at fraction `u` across. */
function strokeOn(sheet: number, layout: { w: number; spread: boolean }, u = 0.3): InkDrawOp {
  const frames = conflictPdfFrames(sizes, layout.w, layout.spread).filter((f) => f.pageId === sheet);
  const top = frames[0]!.minY, bottom = frames[frames.length - 1]!.maxY;
  const y = top + (bottom - top) * 0.4;
  return {
    kind: "draw", color: "#d92243", baseWidth: 4, maxFullness: 1, pressureClip: 1, pressureSensitive: false, id: 9, seq: 9,
    points: [{ x: layout.w * u, y, pressure: NO_PRESSURE }, { x: layout.w * (u + 0.1), y: y + 6, pressure: NO_PRESSURE }],
  };
}

const sheetOf = (op: InkOp, layout: { w: number; spread: boolean }) => {
  const y = op.points[0]!.y;
  return conflictPdfFrames(sizes, layout.w, layout.spread).find((f) => y >= f.minY && y <= f.maxY)?.pageId;
};

describe("convertPdfInkOps", () => {
  it("keeps a mark on its sheet when the column width changes, and comes back exactly", () => {
    const op = strokeOn(30, tablet);
    const [moved] = convertPdfInkOps([op], tablet, desktop, sizes);
    expect(sheetOf(moved!, desktop)).toBe(30);
    expect(moved!.points[0]!.x / desktop.w).toBeCloseTo(op.points[0]!.x / tablet.w, 6);
    expect((moved as InkDrawOp).baseWidth).toBeCloseTo(4 * 760 / 642, 6);
    expect(moved!.id).toBe(9);
    const [back] = convertPdfInkOps([moved!], desktop, tablet, sizes);
    expect(back!.points[0]!.x).toBeCloseTo(op.points[0]!.x, 6);
    expect(back!.points[0]!.y).toBeCloseTo(op.points[0]!.y, 6);
  });

  it("places split-sheet ink on the same sheet of a whole-sheet layout at another width", () => {
    const op = strokeOn(12, split, 0.2);
    const moved = convertPdfInkOps([op], split, desktop, sizes);
    expect(moved.length).toBe(1);
    expect(sheetOf(moved[0]!, desktop)).toBe(12);
    const [back] = convertPdfInkOps(moved, desktop, split, sizes);
    expect(back!.points[0]!.y).toBeCloseTo(op.points[0]!.y, 4);
  });

  it("keeps a margin mark off the sheet instead of pinning it to the edge", () => {
    const op = { ...strokeOn(5, tablet), points: [{ x: -30, y: strokeOn(5, tablet).points[0]!.y, pressure: NO_PRESSURE }] };
    const [moved] = convertPdfInkOps([op], tablet, desktop, sizes);
    expect(moved!.points[0]!.x).toBeLessThan(0);
  });
});

describe("inferPdfInkLayout", () => {
  it("names the other device's layout when the hub copy's width is a hint", () => {
    const pages = [3, 17, 33].map((pageId) => ({ pageId, ops: [strokeOn(pageId, tablet)] }));
    expect(inferPdfInkLayout(pages, sizes, [desktop, tablet])).toEqual(tablet);
  });

  it("without a hint, finds a layout that puts every page's ink on its own sheet", () => {
    const pages = [3, 17, 33].map((pageId) => ({ pageId, ops: [strokeOn(pageId, tablet)] }));
    const found = inferPdfInkLayout(pages, sizes, [desktop])!;
    expect(found.spread).toBe(false);
    expect(Math.abs(found.w - 642)).toBeLessThan(24);
    for (const page of pages) {
      const [moved] = convertPdfInkOps(page.ops, found, desktop, sizes);
      expect(sheetOf(moved!, desktop)).toBe(page.pageId);
    }
  });

  it("prefers the hint when it already fits", () => {
    const pages = [8].map((pageId) => ({ pageId, ops: [strokeOn(pageId, desktop)] }));
    expect(inferPdfInkLayout(pages, sizes, [desktop, tablet])).toEqual(desktop);
  });
});

describe("PDF device layout regression", () => {
  it.each(["left", "right"] as const)("places tablet sheet 45's %s half on desktop sheet 45 on arrival", async (half) => {
    const op = pdfStroke(pdfSizes, tabletLayout, 45, half);
    // Raw tablet Y belongs to a much later desktop sheet, which was the bug.
    const frames = conflictPdfFrames(pdfSizes, desktopLayout.w, false);
    expect(locatePdfInkPoint(op.points[0].x, op.points[0].y, frames, 0, 760)?.pageId).toBeGreaterThan(100);
    const dto = { kind: "annotate" as const, key: `arrival-${half}`, page_id: 45, updated_at: 123,
      gz: bytesToB64(packEncodedInk({ ...encodeInkOps([op]), layout: tabletLayout })) };
    const moved = await localizeHubInkDto(null, dto, { sizes: pdfSizes, layout: desktopLayout });
    const ink = unpackEncodedInk(await bytesFromMaybeGzip(b64ToBytes(moved.gz)))!;
    expect(ink.layout).toEqual(desktopLayout);
    expect(moved).toMatchObject({ localized: true, page_id: 45, updated_at: 123 });
    const [draw] = decodeInkOps(ink);
    expect(draw.id).toBe(op.id);
    draw.points.forEach((point, i) => {
      const expected = pdfStroke(pdfSizes, desktopLayout, 45, half).points[i];
      expect(point.x).toBeCloseTo(expected.x, 1);
      expect(point.y).toBeCloseTo(expected.y, 1);
    });
  });

  it("repeats twelve stored tablet/desktop round trips without drift, lost ids or duplicates", () => {
    const original = storedPdfOps([pdfStroke(pdfSizes, tabletLayout, 45, "left", 101), pdfStroke(pdfSizes, tabletLayout, 45, "right", 102)]);
    let ops = original;
    let firstRoundTrip: InkOp[] | undefined;
    for (let trip = 0; trip < 12; trip++) {
      ops = storedPdfOps(convertPdfInkOps(ops, tabletLayout, desktopLayout, pdfSizes));
      ops = storedPdfOps(convertPdfInkOps(ops, desktopLayout, tabletLayout, pdfSizes));
      expect(ops.map(op => op.id)).toEqual([101, 102]);
      expect(ops.map(op => op.seq)).toEqual([101, 102]);
      ops.forEach((op, i) => op.points.forEach((point, j) => {
        expect(Math.abs(point.x - original[i].points[j].x)).toBeLessThanOrEqual(.15);
        expect(Math.abs(point.y - original[i].points[j].y)).toBeLessThanOrEqual(.15);
      }));
      if (firstRoundTrip) expect(ops.map(op => op.points)).toEqual(firstRoundTrip.map(op => op.points));
      else firstRoundTrip = ops;
      ops.forEach(op => expect((op as InkDrawOp).baseWidth).toBeCloseTo(4, 12));
    }
  });

  const layouts = [642, 760, 913].flatMap(w => [false, true].map(spread => ({ w, spread })));
  it.each(layouts.flatMap(from => layouts.map(to => ({ from, to }))))("maps mixed sheets from $from to $to", ({ from, to }) => {
    for (const size of mixedPdfSizes) for (const half of ["left", "right"] as const) {
      const op = pdfStroke(mixedPdfSizes, from, size.pageNumber, half);
      const [moved] = convertPdfInkOps([op], from, to, mixedPdfSizes);
      expect(moved.id).toBe(op.id);
      moved.points.forEach((point, i) => {
        const expected = pdfStroke(mixedPdfSizes, to, size.pageNumber, half).points[i];
        expect(point.x).toBeCloseTo(expected.x, 7);
        expect(point.y).toBeCloseTo(expected.y, 7);
      });
    }
  });

  it.each([null, 642])("infers untagged split ink with hub width %s and lends that layout to spanning ink", async (hint) => {
    const docId = `legacy-span-${hint}`;
    const ctx = { sizes: pdfSizes, layout: desktopLayout };
    const op = pdfStroke(pdfSizes, tabletLayout, 45, "left");
    const encoded = encodeInkOps([op]);
    const found = await sourcePdfInkLayout(docId, encoded, 45, [op], ctx, hint);
    const point = convertPdfInkOps([op], found, ctx.layout, ctx.sizes)[0].points[0];
    expect(locatePdfInkPoint(point.x, point.y, conflictPdfFrames(pdfSizes, 760, false), 0, 760)?.pageId).toBe(45);
    if (hint) expect(found).toEqual(tabletLayout);
    const spanning = { ...op, points: [pdfPoint(pdfSizes, tabletLayout, 45, "left", .3, .8), pdfPoint(pdfSizes, tabletLayout, 46, "left", .3, .2)] };
    expect(await sourcePdfInkLayout(docId, encodeInkOps([spanning]), 0, [spanning], ctx, hint)).toEqual(found);
    const moved = convertPdfInkOps([spanning], found, ctx.layout, ctx.sizes);
    // Changing split mode cuts a cross-sheet stroke into separate pieces.
    expect(moved).toHaveLength(2);
    expect(moved.map(op => op.points.length)).toEqual([1, 1]);
    expect(moved.flatMap(op => op.points).map(p => locatePdfInkPoint(p.x, p.y, conflictPdfFrames(pdfSizes, 760, false), 0, 760)?.pageId)).toEqual([45, 46]);
  });

  it.each(["left", "right"] as const)("keeps %s margin ink outside the sheet through a stored round trip", half => {
    const nx = half === "left" ? -.08 : 1.08;
    const op = { ...pdfStroke(pdfSizes, tabletLayout, 1, half), points: [pdfPoint(pdfSizes, tabletLayout, 1, half, nx, -.003)] };
    const [moved] = convertPdfInkOps([op], tabletLayout, desktopLayout, pdfSizes);
    const expected = pdfPoint(pdfSizes, desktopLayout, 1, half, nx, -.003);
    expect(moved.points[0].x).toBeCloseTo(expected.x, 7);
    expect(moved.points[0].y).toBeCloseTo(expected.y, 7);
    const [back] = storedPdfOps(convertPdfInkOps(storedPdfOps([moved]), desktopLayout, tabletLayout, pdfSizes));
    expect(back.points[0].x).toBeCloseTo(op.points[0].x, 7);
    expect(back.points[0].y).toBeCloseTo(op.points[0].y, 7);
  });

  it("does not reuse frames from another PDF with the same first sheet and page count", () => {
    const other = mixedPdfSizes.map(size => ({ ...size, height: size.pageNumber === 2 ? 1600 : size.height }));
    for (const book of [mixedPdfSizes, other, mixedPdfSizes]) {
      const op = pdfStroke(book, tabletLayout, 4, "right");
      const [moved] = convertPdfInkOps([op], tabletLayout, desktopLayout, book);
      const expected = pdfStroke(book, desktopLayout, 4, "right");
      expect(moved.points[0].y).toBeCloseTo(expected.points[0].y, 7);
    }
  });

  it("reuses frames without reading every sheet's size for each shard", () => {
    const readSize = vi.fn();
    const sizes = mixedPdfSizes.map(size => ({ ...size, get width() { readSize(); return size.width; } }));
    const op = pdfStroke(mixedPdfSizes, tabletLayout, 4, "right");
    const first = convertPdfInkOps([op], tabletLayout, desktopLayout, sizes);
    expect(readSize).toHaveBeenCalled();
    readSize.mockClear();
    expect(convertPdfInkOps([op], tabletLayout, desktopLayout, sizes)).toEqual(first);
    expect(readSize).not.toHaveBeenCalled();
  });
});
