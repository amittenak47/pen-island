import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PDF_SIZE_CACHE_DOCS,
  cachedPdfPageSizes,
  decodePageSizes,
  encodePageSizes,
  loadPdfPageSizes,
  savePdfPageSizes,
} from "./pdfPageSizeCache";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
  });
});
afterEach(() => vi.unstubAllGlobals());

const book = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ pageNumber: i + 1, width: i === 5 ? 800 : 612, height: 792 }));

it("stores a mostly uniform book as a few runs and reads it back exactly", () => {
  const sizes = book(432);
  expect(encodePageSizes(sizes)).toEqual([[5, 612, 792], [1, 800, 792], [426, 612, 792]]);
  expect(decodePageSizes(encodePageSizes(sizes))).toEqual(sizes);
});

it("answers only for the same file with the same page count", () => {
  savePdfPageSizes("hash-a", book(10));
  expect(loadPdfPageSizes("hash-a", 10)).toEqual(book(10));
  expect(loadPdfPageSizes("hash-a", 11)).toBeNull();
  expect(loadPdfPageSizes("hash-b", 10)).toBeNull();
  expect(loadPdfPageSizes(null, 10)).toBeNull();
});

it("keeps different files' later sheet sizes separate even with the same first sheet and page count", () => {
  const first = book(8), second = book(8);
  second[6] = { ...second[6], width: 1000, height: 600 };
  savePdfPageSizes("first-pdf", first); savePdfPageSizes("second-pdf", second);
  expect(cachedPdfPageSizes("first-pdf")).toEqual(first);
  expect(cachedPdfPageSizes("second-pdf")).toEqual(second);
  expect(loadPdfPageSizes("first-pdf", 8)).toEqual(first);
  expect(loadPdfPageSizes("second-pdf", 8)).toEqual(second);
});

it("forgets the oldest books past the limit", () => {
  for (let i = 0; i <= PDF_SIZE_CACHE_DOCS; i += 1) savePdfPageSizes(`h${i}`, book(2));
  expect(loadPdfPageSizes("h0", 2)).toBeNull();
  expect(loadPdfPageSizes(`h${PDF_SIZE_CACHE_DOCS}`, 2)).toEqual(book(2));
});

it("reuses decoded geometry across sync contexts until its stored runs change", () => {
  savePdfPageSizes("stable-pdf", book(1000));
  const sizes = cachedPdfPageSizes("stable-pdf")!;
  expect(loadPdfPageSizes("stable-pdf", 1000)).toBe(sizes);
  expect(cachedPdfPageSizes("stable-pdf")).toBe(sizes);
  const changed = book(1000);
  changed[500] = { ...changed[500], width: 1000, height: 600 };
  // Another window can replace or remove the stored entry.
  localStorage.setItem("whiteboard.pdfSizes.v1:stable-pdf", JSON.stringify(encodePageSizes(changed)));
  const next = cachedPdfPageSizes("stable-pdf")!;
  expect(next).not.toBe(sizes);
  expect(next).toEqual(changed);
  expect(loadPdfPageSizes("stable-pdf", 1000)).toBe(next);
  localStorage.removeItem("whiteboard.pdfSizes.v1:stable-pdf");
  expect(cachedPdfPageSizes("stable-pdf")).toBeNull();
});

it("rejects damaged entries rather than laying out garbage", () => {
  expect(decodePageSizes([[0, 612, 792]])).toBeNull();
  expect(decodePageSizes([[2, -1, 792]])).toBeNull();
  expect(decodePageSizes("nope")).toBeNull();
});
