/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, TextLayer: class {}, getDocument: () => ({ promise: Promise.resolve() }) }));

const { queryPageSlots } = await import("./PdfDocument");

function slot(page: number): HTMLElement {
  const node = document.createElement("div");
  node.dataset.pdfPage = String(page);
  return node;
}

describe("queryPageSlots", () => {
  it("finds a page's slots and follows a window that shifts without changing size", () => {
    const host = document.createElement("div");
    const pages = [1, 2, 3].map(slot);
    host.append(...pages);
    expect(queryPageSlots(host, 2)).toEqual([pages[1]]);
    // Drop page 1, add page 4: same number of slots.
    pages[0]!.remove();
    const four = slot(4);
    host.append(four);
    expect(queryPageSlots(host, 4)).toEqual([four]);
    expect(queryPageSlots(host, 1)).toEqual([]);
  });

  it("finds both halves of a split page and drops a removed one", () => {
    const host = document.createElement("div");
    const left = slot(5), right = slot(5), other = slot(6);
    host.append(left, right, other);
    expect(queryPageSlots(host, 5)).toEqual([left, right]);
    right.remove();
    expect(queryPageSlots(host, 5)).toEqual([left]);
  });
});
