import { describe, expect, it } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

import { destinationPoint, linkAt, pageLinks, resolvePdfLink, type PdfLink } from "./pdfLinks";

/** A US Letter page at scale 1: PDF space has y up, the sheet y down. */
const viewport = {
  width: 612,
  height: 792,
  convertToViewportPoint: (x: number, y: number) => [x, 792 - y],
};

describe("pageLinks", () => {
  it("keeps link annotations as sheet boxes, by where they go", () => {
    const links = pageLinks([
      { subtype: "Link", rect: [72, 692, 272, 712], dest: "ch1" },
      { subtype: "Link", rect: [72, 600, 160, 620], url: "https://example.com" },
      { subtype: "Link", rect: [72, 500, 160, 520], action: "NextPage" },
      { subtype: "Link", rect: [72, 400, 160, 420], url: "file:///etc/passwd" },
      { subtype: "Widget", rect: [0, 0, 10, 10] },
    ], viewport);
    expect(links.map((link) => link.target)).toEqual([
      { kind: "dest", dest: "ch1" },
      { kind: "url", url: "https://example.com" },
      { kind: "named", action: "NextPage" },
    ]);
    expect(links[0]!.box.top).toBeCloseTo(80 / 792);
    expect(links[0]!.box.left).toBeCloseTo(72 / 612);
    expect(links[0]!.box.height).toBeCloseTo(20 / 792);
  });
});

describe("linkAt", () => {
  const box = (left: number, top: number, width: number, height: number): PdfLink => ({
    box: { left, top, width, height },
    target: { kind: "named", action: `${left}` },
  });
  it("finds the link under a point, the smallest of overlapping ones", () => {
    const links = [box(0, 0, 1, 1), box(0.1, 0.1, 0.2, 0.05)];
    expect(linkAt(links, 0.15, 0.12)).toBe(links[1]);
    expect(linkAt(links, 0.5, 0.5)).toBe(links[0]);
    expect(linkAt([links[1]!], 0.5, 0.5)).toBeNull();
  });
});

describe("destinationPoint", () => {
  it("reads the line an XYZ or FitH destination names, and nothing for a whole page", () => {
    expect(destinationPoint([{ num: 1 }, { name: "XYZ" }, 0, 396, null], viewport)).toEqual({ x: 0, y: 0.5 });
    expect(destinationPoint([{ num: 1 }, { name: "FitH" }, 792], viewport)).toEqual({ x: null, y: 0 });
    expect(destinationPoint([{ num: 1 }, { name: "Fit" }], viewport)).toEqual({ x: null, y: null });
    expect(destinationPoint([{ num: 1 }, { name: "XYZ" }, null, null, 0], viewport)).toEqual({ x: null, y: null });
  });
});

describe("resolvePdfLink", () => {
  const doc = {
    numPages: 8,
    getDestination: async (name: string) => (name === "sec23" ? [{ num: 30, gen: 0 }, { name: "XYZ" }, 0, 396, 0] : null),
    getPageIndex: async () => 4,
    getPage: async () => ({ getViewport: () => viewport }),
  } as unknown as PDFDocumentProxy;
  const link = (target: PdfLink["target"]): PdfLink => ({ box: { left: 0, top: 0, width: 1, height: 1 }, target });

  it("follows a named destination to its page and line", async () => {
    expect(await resolvePdfLink(doc, link({ kind: "dest", dest: "sec23" }), 1)).toEqual({ page: 5, x: 0, y: 0.5 });
  });

  it("takes a page index as the first entry, and gives up on a name the file doesn't have", async () => {
    expect(await resolvePdfLink(doc, link({ kind: "dest", dest: [2, { name: "Fit" }] }), 1)).toEqual({ page: 3, x: null, y: null });
    expect(await resolvePdfLink(doc, link({ kind: "dest", dest: "missing" }), 1)).toBeNull();
  });

  it("turns next and previous page links into pages, within the file", async () => {
    expect(await resolvePdfLink(doc, link({ kind: "named", action: "NextPage" }), 3)).toEqual({ page: 4, x: null, y: null });
    expect(await resolvePdfLink(doc, link({ kind: "named", action: "PrevPage" }), 1)).toBeNull();
    expect(await resolvePdfLink(doc, link({ kind: "named", action: "LastPage" }), 1)).toEqual({ page: 8, x: null, y: null });
  });
});
