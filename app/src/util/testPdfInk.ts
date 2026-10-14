import { decodeInkOps, encodeInkOps, packEncodedInk, unpackEncodedInk, type PdfInkLayout } from "../canvas/inkCodec";
import { NO_PRESSURE, type InkDrawOp, type InkOp } from "../canvas/rasterInk";
import { conflictPdfFrames } from "../components/conflictDocumentLayout";
import { placePdfInkPoint, type PdfInkHalf } from "../modes/pdfInkSpread";
import type { PdfPageSize } from "../modes/pdfPageSizeCache";

export const tabletLayout = { w: 642, spread: true };
export const desktopLayout = { w: 760, spread: false };
export const pdfSizes: PdfPageSize[] = Array.from({ length: 160 }, (_, i) => ({ pageNumber: i + 1, width: 531, height: 666 }));
export const mixedPdfSizes: PdfPageSize[] = [
  { pageNumber: 1, width: 612, height: 792 },
  { pageNumber: 2, width: 1000, height: 600 },
  { pageNumber: 3, width: 420, height: 900 },
  { pageNumber: 4, width: 842, height: 595 },
];

export function pdfPoint(sizes: readonly PdfPageSize[], layout: PdfInkLayout, pageId: number, half: PdfInkHalf, nx: number, ny: number) {
  return { ...placePdfInkPoint({ pageId, half, nx, ny }, conflictPdfFrames(sizes, layout.w, layout.spread), 0, layout.w, false)!, pressure: NO_PRESSURE };
}

export function pdfStroke(sizes: readonly PdfPageSize[], layout: PdfInkLayout, pageId: number, half: PdfInkHalf = "left", id = 91): InkDrawOp {
  return {
    kind: "draw", id, seq: id, color: "#d92243", baseWidth: 4, maxFullness: 1, pressureClip: 1, pressureSensitive: false,
    points: [pdfPoint(sizes, layout, pageId, half, .23, .37), pdfPoint(sizes, layout, pageId, half, .41, .43)],
  };
}

/** Exercise the same tenth-unit point rounding as a saved page. */
export function storedPdfOps(ops: readonly InkOp[]): InkOp[] {
  return decodeInkOps(unpackEncodedInk(packEncodedInk(encodeInkOps(ops)))!);
}

export function pdfBoard(layout: PdfInkLayout, sizes: readonly PdfPageSize[] = pdfSizes) {
  const frames = conflictPdfFrames(sizes, layout.w, layout.spread);
  return { v: 1 as const, elements: [{ id: "lcmdink-0-frame", width: layout.w, height: frames.at(-1)!.maxY, customData: { lcMdInkFrame: true } }],
    appState: { scrollX: 0, scrollY: 0, zoom: 1, pdfSpread: layout.spread, pdfWidth: layout.w } };
}
