/** @vitest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decodeThumbsAround, keepThumb, openThumbBook, pruneThumbBooks, resetPageThumbsForTests, setThumbCodecForTests,
  thumbBookKey, thumbInk, thumbOrder, thumbPicture, type ThumbCodec,
} from "./pageThumbs";

const frames = Array.from({ length: 60 }, (_, i) => ({ pageId: i + 1, minY: i * 600, maxY: i * 600 + 580 }));
const box = { minX: 0, maxX: 400, minY: 0, maxY: 600 };

/** Bytes are the page's own number, so a decoded picture says which page it came from. */
const decoded: Array<{ page: number; close: () => void }> = [];
const codec: ThumbCodec = {
  encode: async (canvas) => ({ data: new Uint8Array([Number(canvas.dataset.page ?? 0), 1, 2, 3]).buffer, type: "image/webp" }),
  decode: async (data) => {
    const picture = { page: new Uint8Array(data)[0]!, width: 200, height: 300, close: vi.fn() };
    decoded.push(picture);
    return picture as unknown as ImageBitmap;
  },
};
const page = (n: number) => {
  const canvas = document.createElement("canvas");
  canvas.dataset.page = String(n);
  return canvas;
};
/** A new session: the same disk, nothing in memory. */
const relaunch = () => resetPageThumbsForTests();

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  setThumbCodecForTests(codec);
  decoded.length = 0;
});

afterEach(() => {
  resetPageThumbsForTests();
  setThumbCodecForTests(null);
  vi.unstubAllGlobals();
});

describe("a note's kept page pictures", () => {
  it("files a note's pictures by its content, where its pages are cut, and its palette", () => {
    const key = thumbBookKey("doc", frames, box, "dark");
    expect(key).toBe(thumbBookKey("doc", frames.map((f) => ({ ...f })), box, "dark"));
    expect(thumbBookKey("other", frames, box, "dark")).not.toBe(key);
    expect(thumbBookKey("doc", frames, box, "light")).not.toBe(key);
    expect(thumbBookKey("doc", frames, { ...box, maxX: 500 }, "dark")).not.toBe(key);
    expect(thumbBookKey("doc", [...frames.slice(0, 10), { ...frames[10]!, maxY: 6400 }, ...frames.slice(11)], box, "dark")).not.toBe(key);
    expect(thumbBookKey(null, frames, box, "dark")).toBeNull();
    expect(thumbBookKey("doc", [], box, "dark")).toBeNull();
  });

  it("keeps a page's picture on disk with its ink, for the next time the note opens", async () => {
    const key = thumbBookKey("doc", frames, box, "dark")!;
    await keepThumb(key, 4, page(4), "ink-a");
    expect(thumbPicture(key, 4)).not.toBeNull();
    relaunch();
    const book = openThumbBook(key);
    expect(thumbPicture(key, 4)).toBeNull();
    await book.loaded;
    expect(thumbInk(key, 4)).toBe("ink-a");
    expect(thumbInk(key, 5)).toBeNull();
    await decodeThumbsAround(key, 4);
    expect((thumbPicture(key, 4) as unknown as { page: number }).page).toBe(4);
    // Retaken after a stroke: the new ink, the new picture.
    await keepThumb(key, 4, page(44), "ink-b");
    relaunch();
    await openThumbBook(key).loaded;
    expect(thumbInk(key, 4)).toBe("ink-b");
    await decodeThumbsAround(key, 4);
    expect((thumbPicture(key, 4) as unknown as { page: number }).page).toBe(44);
  });

  it("keeps pictures in a store something else opened first and left without its stores", async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.open("whiteboard.pageThumbs");
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    const key = thumbBookKey("doc", frames, box, "dark")!;
    await keepThumb(key, 2, page(2), "ink");
    relaunch();
    await openThumbBook(key).loaded;
    expect(thumbInk(key, 2)).toBe("ink");
  });

  it("decodes the pages around where the reader is, more of them ahead, and lets go of the rest", async () => {
    const key = thumbBookKey("doc", frames, box, "dark")!;
    for (let i = 0; i < 60; i += 1) await keepThumb(key, i, page(i), "", false);
    expect(thumbPicture(key, 0)).toBeNull();
    relaunch();
    await decodeThumbsAround(key, 20, 1);
    const shown = () => Array.from({ length: 60 }, (_, i) => (thumbPicture(key, i) ? i : -1)).filter((i) => i >= 0);
    expect(shown()).toEqual(Array.from({ length: 37 }, (_, i) => 8 + i));
    // Heading back now: the window turns round, and what fell out is closed.
    await decodeThumbsAround(key, 20, -1);
    expect(shown()).toEqual(Array.from({ length: 37 }, (_, i) => -4 + i).filter((i) => i >= 0));
    expect(decoded.find((d) => d.page === 44)!.close).toHaveBeenCalled();
  });

  it("holds one window's worth decoded however many notes are open, the note being read kept", async () => {
    const first = thumbBookKey("first", frames, box, "dark")!;
    const second = thumbBookKey("second", frames, box, "dark")!;
    for (let i = 0; i < 40; i += 1) {
      await keepThumb(first, i, page(i), "", false);
      await keepThumb(second, i, page(i), "", false);
    }
    relaunch();
    await decodeThumbsAround(first, 12, 1);
    await decodeThumbsAround(second, 12, 1);
    const count = (key: string) => Array.from({ length: 40 }, (_, i) => thumbPicture(key, i)).filter(Boolean).length;
    expect(count(second)).toBe(37);
    expect(count(first) + count(second)).toBeLessThanOrEqual(40);
  });

  it("makes room on disk by the notes read longest ago, never one open now", async () => {
    const keys = ["a", "b", "c"].map((doc) => thumbBookKey(doc, frames, box, "dark")!);
    for (const key of keys) {
      for (let i = 0; i < 10; i += 1) await keepThumb(key, i, page(i), "");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    relaunch();
    // Note b is open in a tab; each book holds 40 bytes, and room is left for one.
    await openThumbBook(keys[1]!).loaded;
    await pruneThumbBooks(45);
    relaunch();
    for (const key of keys) await openThumbBook(key).loaded;
    expect(keys.map((key) => thumbInk(key, 0))).toEqual([null, "", null]);
  });

  it("pictures a spread's pages from here outward, two spreads ahead for each one back", () => {
    expect(thumbOrder(9, 20, 1, 2)).toEqual([8, 9, 10, 11, 12, 13, 6, 7, 14, 15, 16, 17, 4, 5, 18, 19, 2, 3, 0, 1]);
    expect(thumbOrder(5, 9, -1, 1)).toEqual([5, 4, 3, 6, 2, 1, 7, 0, 8]);
  });
});
