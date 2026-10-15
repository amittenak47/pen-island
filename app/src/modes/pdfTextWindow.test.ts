import { describe, expect, it, vi } from "vitest";
import { pdfSelectablePages, PdfTextWindow } from "./pdfTextWindow";

describe("PDF selectable text window", () => {
  it("uses the paint hole, caps wide zooms at three pages, and ignores rest neighbours", () => {
    expect(pdfSelectablePages(12, [11, 12])).toEqual([11, 12]);
    expect(pdfSelectablePages(12, [10, 11, 12, 13, 14])).toHaveLength(3);
    expect(pdfSelectablePages(12, [1])).toEqual([12]);
  });

  it("drops pages leaving the hole and never builds neighbouring layers", async () => {
    const drop = vi.fn(), fill = vi.fn(async () => true);
    const window = new PdfTextWindow(drop);
    window.retain([1, 2]);
    expect(await window.ensure(1, fill)).toBe(true);
    expect(await window.ensure(3, fill)).toBe(false);
    window.retain([2, 3]);
    expect(drop).toHaveBeenCalledWith(1);
    expect(window.has(1)).toBe(false);
    expect(await window.ensure(2, fill)).toBe(true);
    expect(await window.ensure(2, fill)).toBe(true);
    expect(fill).toHaveBeenCalledTimes(2);
  });

  it("shares on-demand fills, cancels departed partial layers, and does not resurrect them", async () => {
    const drop = vi.fn(), window = new PdfTextWindow(drop);
    let finish!: (ok: boolean) => void, aborted = false;
    const fill = vi.fn(async (signal: AbortSignal) => {
      signal.addEventListener("abort", () => { aborted = true; });
      return new Promise<boolean>(resolve => { finish = resolve; });
    });
    window.retain([2]);
    const first = window.ensure(2, fill), second = window.ensure(2, fill, true);
    expect(second).toBe(first);
    await Promise.resolve();
    window.retain([3]);
    expect(aborted).toBe(true);
    expect(drop).toHaveBeenCalledWith(2);
    finish(true);
    expect(await first).toBe(false);
    expect(window.has(2)).toBe(false);
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it("bounds explicit quote fills too and retries failed or empty-page fills correctly", async () => {
    const drop = vi.fn(), window = new PdfTextWindow(drop);
    for (const page of [1, 2, 3, 4]) expect(await window.ensure(page, async () => true, true)).toBe(true);
    expect(drop).toHaveBeenCalledWith(1);
    expect([1, 2, 3, 4].filter(page => window.has(page))).toEqual([2, 3, 4]);
    expect(await window.ensure(5, async () => false, true)).toBe(false);
    expect(window.has(5)).toBe(false);
    const empty = vi.fn(async () => true);
    expect(await window.ensure(5, empty, true)).toBe(true);
    expect(await window.ensure(5, empty, true)).toBe(true);
    expect(empty).toHaveBeenCalledTimes(1);
    window.clear();
    expect(window.has(5)).toBe(false);
  });
});
