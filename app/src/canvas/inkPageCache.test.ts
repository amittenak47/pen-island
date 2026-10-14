import { describe, expect, it, vi } from "vitest";

import { InkPageBook } from "./inkPageCache";
import { contentBottomInFrame } from "../templates/drawPageGrowth";
import { INK_LRU_RADIUS, SPANNING_PAGE_ID, type PageFrame } from "./inkPageIndex";
import { decodeInkOps, encodeInkOps, lazyEncodedInk, packEncodedInk, summarizeEncodedInk } from "./inkCodec";
import { NO_PRESSURE, inkOpsBounds, type InkDrawOp, type InkEraseOp } from "./rasterInk";

function frames(count: number): PageFrame[] {
  const out: PageFrame[] = [];
  let y = 0;
  for (let i = 1; i <= count; i += 1) {
    out.push({ pageId: i, minY: y, maxY: y + 100 });
    y += 118;
  }
  return out;
}

function stroke(y: number, extra: Partial<InkDrawOp> = {}): InkDrawOp {
  return {
    kind: "draw",
    color: "#111",
    baseWidth: 2,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    points: [
      { x: 10, y, pressure: NO_PRESSURE },
      { x: 20, y, pressure: NO_PRESSURE },
    ],
    ...extra,
  };
}

describe("InkPageBook", () => {
  it("keeps ink read back from storage filed as it was when the layout arrives", () => {
    const layout = frames(20);
    const saved = new InkPageBook();
    saved.replaceAll(layout.map(f => stroke(f.minY + 40)), { frames: layout });
    const pages = saved.snapshotEncodedPages();
    const book = new InkPageBook();
    book.ingestEncodedPages(pages);
    // Far pages stay encoded: a rebin would have decoded and rewritten them.
    const far = book.cold.get(20)!;
    Object.defineProperty(far.ops[0], "pr", { get() { throw new Error("Decoded cold ink on layout"); } });
    expect(book.setFrames(layout)).toBe(false);
    expect(book.cold.get(20)).toBe(far);
    expect(book.takeDirtyEncoded().size).toBe(0);
  });

  it("rebins stored ink that does not sit on the page it was filed under", () => {
    const layout = frames(3);
    const book = new InkPageBook();
    // Filed on page 1 while the layout was unknown, but drawn on page 3.
    book.ingestEncodedPages(new Map([[1, encodeInkOps([stroke(layout[2]!.minY + 40)])]]));
    expect(book.setFrames(layout)).toBe(true);
    expect(book.pageIds()).toContain(3);
  });

  it("writes each stroke once, whatever copies are in memory", () => {
    const book = new InkPageBook();
    book.setFrames(frames(3));
    const a = stroke(30, { id: 1, seq: 1 });
    book.replaceAll([a, { ...a }, { ...a, points: a.points.map((p) => ({ ...p })) }, stroke(150)], { preserveIds: true, frames: frames(3) });
    const written = book.takeDirtyEncoded();
    expect(decodeInkOps(written.get(1)!)).toHaveLength(1);
    expect(decodeInkOps(written.get(2)!)).toHaveLength(1);
  });

  it("rewrites only the pages a rebin changes", () => {
    const layout = frames(6);
    const saved = new InkPageBook();
    saved.replaceAll(layout.map(f => stroke(f.minY + 40)), { frames: layout });
    const book = new InkPageBook();
    book.ingestEncodedPages(saved.snapshotEncodedPages());
    // Drawn on page 3 while the stand-in layout files everything on page 1.
    book.commit(stroke(layout[2]!.minY + 60));
    expect(book.setFrames(layout)).toBe(true);
    expect([...book.takeDirtyEncoded().keys()].sort()).toEqual([1, 3]);
    expect(book.pageIds()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reads and caches cold geometry without decoding strokes or changing the paint window", () => {
    const book = new InkPageBook();
    const layout = frames(20);
    book.replaceAll(layout.map(f => stroke(f.minY + 40)), { frames: layout });
    const expected = inkOpsBounds(book.assembleOps());
    const hot = [...book.hot.keys()];
    const revision = book.revision();
    const cold = book.cold.get(20)!;
    Object.defineProperty(cold.ops[0], "pr", { get() { throw new Error("Decoded cold ink"); } });
    expect(book.inkBounds()).toEqual(expected);
    Object.defineProperty(cold.ops[0], "xy", { get() { throw new Error("Rescanned cached ink"); } });
    expect(book.inkBounds()).toEqual(expected);
    expect([...book.hot.keys()]).toEqual(hot);
    expect(book.revision()).toBe(revision);
    book.commit(stroke(50));
    expect(book.inkBounds()).toEqual(expected);
  });

  it("updates bounds through edits, undo, clear, restore and page eviction", () => {
    const book = new InkPageBook();
    book.setFrames(frames(20));
    const check = () => expect(book.inkBounds()).toEqual(inkOpsBounds(book.assembleOps()));
    check();
    book.commit(stroke(40)); check();
    book.commit(stroke(1100)); check();
    book.undoOnce(); check();
    book.redoOnce(); check();
    book.setVisiblePage(10); check();
    book.strokeErase({ kind: "erase", radius: 30, points: [{ x: 15, y: 1100, pressure: 1 }] }); check();
    book.undoOnce(); check();
    book.partialErase({ kind: "erase", radius: 2, points: [{ x: 15, y: 1100, pressure: 1 }] }); check();
    book.undoOnce(); check();
    const saved = book.snapshotEncodedPages();
    book.clear(); check();
    book.undoOnce(); check();
    book.redoOnce(); check();
    book.ingestEncodedPages(saved); check();
    book.setVisiblePage(1); check();
    book.seedCold([[20, encodeInkOps([stroke(2300)])]]); check();
    book.replaceAll([stroke(55)], { frames: frames(2) }); check();
  });

  it("captures cold page ink without decoding unrelated pages or moving the reading window", () => {
    const book = new InkPageBook();
    const layout = frames(20);
    book.replaceAll(layout.map(f => stroke(f.minY + 40)), { frames: layout });
    book.setVisiblePage(1);
    const hot = [...book.hot.keys()];
    const revision = book.revision();
    // An unrelated cold page must never be decoded by a page-10 capture.
    book.cold.set(20, { v: 2, get ops(): never { throw new Error("Decoded page 20"); } });
    const target = layout[9];
    const captured = book.opsInBounds({ minX: 0, maxX: 100, minY: target.minY, maxY: target.maxY });
    expect(captured).toHaveLength(1);
    expect((captured[0] as InkDrawOp).points[0].y).toBe(target.minY + 40);
    expect([...book.hot.keys()]).toEqual(hot);
    expect(book.visiblePage).toBe(1);
    expect(book.revision()).toBe(revision);
  });
  it("omits untouched viewport slots but retains erased stored pages", () => {
    const book = new InkPageBook();
    book.setFrames(frames(8));
    book.setVisiblePage(1);
    book.setVisiblePage(7);
    expect(book.pageIds()).toEqual([]);
    book.commit(stroke(20));
    expect(book.pageIds()).toEqual([1]);
    book.undoOnce();
    expect(book.pageIds()).toEqual([1]);
    expect(book.takeDirtyEncoded().get(1)?.ops).toEqual([]);
    book.markFlushed([1]);
    expect(book.pageIds()).toEqual([1]);
    expect(book.snapshotEncodedPages().get(1)?.ops).toEqual([]);
  });
  it("snapshots clean empty and authored pages even when no dirty shards remain", () => {
    const book = new InkPageBook();
    book.ingestEncodedPages(new Map([[0,{v:2,ops:[]}]]));
    book.setFrames(frames(2));
    book.setVisiblePage(1);
    book.commit(stroke(40));
    book.markFlushed(book.pageIds());
    expect(book.takeDirtyEncoded().size).toBe(0);
    const saved = book.snapshotEncodedPages();
    expect([...saved.keys()]).toEqual(book.pageIds());
    expect([...saved.values()].some(page => page.ops.length === 0)).toBe(true);
    const restored = new InkPageBook();
    restored.setFrames(frames(2));
    restored.ingestEncodedPages(saved);
    expect(restored.assembleOps()).toEqual(book.assembleOps());
    book.clear();
    const blank = new InkPageBook();
    blank.ingestEncodedPages(book.snapshotEncodedPages());
    expect(blank.assembleOps()).toEqual([]);
  });
  it("keeps decoded ops only for the LRU window plus spanning", () => {
    const book = new InkPageBook();
    book.setFrames(frames(20));
    book.setVisiblePage(10);
    for (let page = 1; page <= 20; page += 1) {
      book.visiblePage = page;
      book.commit(stroke(page * 118 - 80));
    }
    expect(book.setVisiblePage(10)).toBe(true);
    expect(book.setVisiblePage(10)).toBe(false);
    const hotPages = [...book.hot.keys()].filter((id) => id !== SPANNING_PAGE_ID).sort((a, b) => a - b);
    expect(hotPages).toEqual(
      Array.from({ length: 1 + 2 * INK_LRU_RADIUS }, (_, i) => 10 - INK_LRU_RADIUS + i),
    );
    expect(book.opCount()).toBe(20);
    expect(book.paintOps().length).toBeLessThan(book.opCount());
    expect(book.assembleOps()).toHaveLength(20);
  });

  it("gives back a page's stored copy when moving off it unchanged, and encodes it again once written", () => {
    const book = new InkPageBook();
    book.setFrames(frames(20));
    const stored = encodeInkOps([stroke(20 * 118 - 80, { id: 1, seq: 1 })]);
    book.ingestEncodedPages([[20, stored]]);
    book.setVisiblePage(20);
    expect(book.hot.has(20)).toBe(true);
    book.setVisiblePage(1);
    expect(book.cold.get(20)).toBe(stored);

    book.setVisiblePage(20);
    book.commit(stroke(20 * 118 - 60));
    book.markFlushed([20]);
    book.setVisiblePage(1);
    expect(book.cold.get(20)).not.toBe(stored);
    expect(decodeInkOps(book.cold.get(20)!)).toHaveLength(2);
  });

  it("undoes the last stroke even after scrolling to another page", () => {
    const book = new InkPageBook();
    book.setFrames(frames(10));
    book.setVisiblePage(1);
    book.commit(stroke(40));
    book.setVisiblePage(10);
    const second = book.commit(stroke(10 * 118 - 80));
    expect(book.opCount()).toBe(2);
    expect(book.undoOnce()?.kind).toBe("add");
    expect(book.assembleOps().some((op) => op.id === second.id)).toBe(false);
    expect(book.assembleOps()).toHaveLength(1);
    expect(book.redoOnce()?.kind).toBe("add");
    expect(book.assembleOps()).toHaveLength(2);
  });

  it("bins a seam-crossing stroke to page 0 once", () => {
    const book = new InkPageBook();
    book.setFrames(frames(3));
    book.commit(
      stroke(90, {
        points: [
          { x: 10, y: 90, pressure: NO_PRESSURE },
          { x: 10, y: 130, pressure: NO_PRESSURE },
        ],
      }),
    );
    expect(book.hot.get(SPANNING_PAGE_ID)?.length ?? book.cold.get(SPANNING_PAGE_ID)).toBeTruthy();
    const spanning = book.hot.get(SPANNING_PAGE_ID) ?? decodeInkOps(book.cold.get(SPANNING_PAGE_ID)!);
    expect(spanning).toHaveLength(1);
    expect(book.hot.get(1) ?? []).toHaveLength(0);
    expect(book.hot.get(2) ?? []).toHaveLength(0);
  });

  it("does not snapshot the whole book on each commit", () => {
    const book = new InkPageBook();
    book.setFrames(frames(4));
    book.commit(stroke(20));
    book.commit(stroke(30));
    expect(book.undo).toHaveLength(2);
    expect(book.undo.every((entry) => entry.kind === "add")).toBe(true);
  });

  it("assembles encoded shards without decoding cold pages", () => {
    const book = new InkPageBook();
    book.setFrames(frames(12));
    book.setVisiblePage(1);
    for (let page = 1; page <= 12; page += 1) {
      book.commit(stroke(page * 118 - 80));
    }
    book.setVisiblePage(1);
    const encoded = book.assembleEncoded();
    expect(decodeInkOps(encoded)).toHaveLength(12);
    expect(book.hot.size).toBeLessThan(12);
  });

  it("marks dirty pages and clears them on flush", () => {
    const book = new InkPageBook();
    book.setFrames(frames(3));
    book.commit(stroke(20));
    expect(book.dirtyCount()).toBe(1);
    const dirty = book.takeDirtyEncoded();
    expect(dirty.size).toBe(1);
    book.markFlushed(dirty.keys());
    expect(book.dirtyCount()).toBe(0);
  });

  it("stroke-erase records removed ops for undo, not a full list snapshot", () => {
    const book = new InkPageBook();
    book.setFrames(frames(2));
    const a = book.commit(stroke(20));
    book.commit(stroke(200));
    const erase: InkEraseOp = {
      kind: "erase",
      radius: 20,
      points: [
        { x: 10, y: 20, pressure: NO_PRESSURE },
        { x: 12, y: 20, pressure: NO_PRESSURE },
      ],
    };
    expect(book.strokeErase(erase)).not.toBeNull();
    expect(book.assembleOps().some((op) => op.id === a.id)).toBe(false);
    expect(book.opCount()).toBe(1);
    book.undoOnce();
    expect(book.assembleOps().some((op) => op.id === a.id)).toBe(true);
  });

  it("partial-erase cuts the stroke out of the book so remesh cannot restore it", () => {
    const book = new InkPageBook();
    book.setFrames(frames(2));
    book.commit(
      stroke(20, {
        points: [
          { x: 0, y: 20, pressure: NO_PRESSURE },
          { x: 100, y: 20, pressure: NO_PRESSURE },
        ],
      }),
    );
    const erase: InkEraseOp = {
      kind: "erase",
      radius: 8,
      points: [
        { x: 50, y: 20, pressure: NO_PRESSURE },
        { x: 52, y: 20, pressure: NO_PRESSURE },
      ],
    };
    expect(book.partialErase(erase)).not.toBeNull();
    expect(book.assembleOps().some((op) => op.kind === "erase")).toBe(false);
    expect(book.opCount()).toBeGreaterThan(0);
    book.undoOnce();
    expect(book.opCount()).toBe(1);
  });

  it("writes baked draws on flush so dest-out erases cannot come back", () => {
    const book = new InkPageBook();
    book.setFrames(frames(1));
    book.commit(stroke(20));
    book.commit({
      kind: "erase",
      radius: 8,
      points: [
        { x: 10, y: 20, pressure: NO_PRESSURE },
        { x: 12, y: 20, pressure: NO_PRESSURE },
      ],
    });
    const dirty = book.takeDirtyEncoded();
    const encoded = [...dirty.values()][0]!;
    const ops = decodeInkOps(encoded);
    expect(ops.some((op) => op.kind === "erase")).toBe(false);
  });

  it("bumps revision on undo-then-redraw so the same op count is not the same mix", () => {
    const book = new InkPageBook();
    book.setFrames(frames(2));
    book.commit(stroke(20));
    const afterDraw = book.revision();
    book.undoOnce();
    book.commit(stroke(20));
    expect(book.opCount()).toBe(1);
    expect(book.revision()).toBeGreaterThan(afterDraw);
  });

  it("undoes and redoes the whole session beyond the old 40-stroke cap", () => {
    const book = new InkPageBook();
    book.setFrames(frames(1));
    for (let i = 0; i < 200; i += 1) book.commit(stroke(20 + i));
    expect(book.canUndo()).toBe(true);
    for (let i = 0; i < 200; i += 1) expect(book.undoOnce()).not.toBeNull();
    expect(book.undoOnce()).toBeNull();
    expect(book.opCount()).toBe(0);
    expect(book.canUndo()).toBe(false);
    for (let i = 0; i < 200; i += 1) expect(book.redoOnce()).not.toBeNull();
    expect(book.opCount()).toBe(200);
    expect(book.redoOnce()).toBeNull();
  });

  it("a new stroke drops redo so Redo is a no-op, not a remesh", () => {
    const book = new InkPageBook();
    book.setFrames(frames(1));
    book.commit(stroke(20));
    expect(book.canRedo()).toBe(false);
    book.undoOnce();
    expect(book.canRedo()).toBe(true);
    book.commit(stroke(40));
    expect(book.canRedo()).toBe(false);
    expect(book.redoOnce()).toBeNull();
  });

  it("does not treat a still LRU window as a hydrate", () => {
    const book = new InkPageBook();
    book.setFrames(frames(3));
    book.commit(stroke(20));
    expect(book.setVisiblePage(1)).toBe(false);
    expect(book.setVisiblePage(2)).toBe(false);
    expect(book.setVisiblePage(3)).toBe(false);
  });

  it("answers host-bound without assembling paint ops", () => {
    const book = new InkPageBook();
    book.setFrames(frames(1));
    book.commit(stroke(20));
    expect(book.hasHostBoundInk()).toBe(false);
    book.commit(
      stroke(20, {
        hostKey: 0,
        scrollLeftAtDraw: 0,
        scrollTopAtDraw: 0,
      }),
    );
    expect(book.hasHostBoundInk()).toBe(true);
  });

  it("rebins fallback page-1 strokes onto the real notebook pages", () => {
    const book = new InkPageBook();
    book.commit(stroke(40));
    book.commit(stroke(160));
    expect(book.pageIds()).toEqual([1]);
    expect(book.setFrames(frames(2))).toBe(true);
    const page1 = book.hot.get(1) ?? decodeInkOps(book.cold.get(1)!);
    const page2 = book.hot.get(2) ?? decodeInkOps(book.cold.get(2)!);
    expect(page1).toHaveLength(1);
    expect(page2).toHaveLength(1);
  });

  it("rebins when a layout change moves pages, and writes the pages it emptied", () => {
    const book = new InkPageBook();
    book.setFrames(frames(4));
    book.commit(stroke(3 * 118 + 40)); // page 4
    book.takeDirtyEncoded();
    book.markFlushed([4]);
    // A new layout: every page half as tall, so y=394 now falls on page 4's
    // successor slot... here, page 2 in a stack of 200-unit pages.
    const moved: PageFrame[] = [
      { pageId: 1, minY: 0, maxY: 200 },
      { pageId: 2, minY: 218, maxY: 418 },
      { pageId: 3, minY: 436, maxY: 636 },
      { pageId: 4, minY: 654, maxY: 854 },
    ];
    expect(book.setFrames(moved)).toBe(true);
    const dirty = book.takeDirtyEncoded();
    expect(decodeInkOps(dirty.get(2)!)).toHaveLength(1);
    // Page 4's old copy is written empty rather than left on disk.
    expect(dirty.has(4)).toBe(true);
    expect(decodeInkOps(dirty.get(4)!)).toHaveLength(0);
  });

  it("does not rebin when the layout only grows", () => {
    const book = new InkPageBook();
    book.setFrames(frames(2));
    book.commit(stroke(40));
    book.takeDirtyEncoded();
    book.markFlushed([1]);
    expect(book.setFrames(frames(5))).toBe(false);
    expect(book.takeDirtyEncoded().size).toBe(0);
  });

  it("bins replaced ink by the frames it is given", () => {
    const book = new InkPageBook();
    book.setFrames(frames(4));
    const halfTall: PageFrame[] = [
      { pageId: 1, minY: 0, maxY: 200 },
      { pageId: 2, minY: 218, maxY: 418 },
    ];
    book.replaceAll([stroke(300)], { frames: halfTall });
    const dirty = book.takeDirtyEncoded();
    expect(decodeInkOps(dirty.get(2)!)).toHaveLength(1);
    expect(dirty.has(3)).toBe(false);
  });

  it("opens stored pages from their summaries, unpacking only the pages read", () => {
    const layout = frames(20);
    const saved = new InkPageBook();
    saved.replaceAll(layout.map((f, i) => stroke(f.minY + 40, { id: 100 + i, seq: 200 + i })), { frames: layout, preserveIds: true });
    const pages = saved.snapshotEncodedPages();
    const unpacked = new Set<number>();
    const lazy = new Map([...pages].map(([id, encoded]) => {
      const page = lazyEncodedInk(packEncodedInk(encoded), summarizeEncodedInk(encoded));
      const read = Object.getOwnPropertyDescriptor(page, "ops")!.get!;
      Object.defineProperty(page, "ops", { enumerable: true, get: () => (unpacked.add(id), read()) });
      return [id, page] as const;
    }));
    const book = new InkPageBook();
    book.setFrames(layout);
    book.ingestEncodedPages(lazy);
    expect(book.opCount()).toBe(20);
    expect(book.setFrames(layout)).toBe(false);
    expect(book.inkBounds()).toEqual(saved.inkBounds());
    expect(book.pageIds()).toEqual(saved.pageIds());
    // Only the reading window around page 1 was read.
    expect([...unpacked].every((id) => id <= 1 + INK_LRU_RADIUS)).toBe(true);
    expect(book.paintOps().map((op) => op.id)).toContain(100);
    // A new stroke still gets an id and seq past every stored one.
    const added = book.commit(stroke(layout[0]!.minY + 60));
    expect(added.id).toBeGreaterThan(119);
    expect(added.seq).toBeGreaterThan(219);
  });
});

describe("frame-scoped growth cache", () => {
  const frame = { x: 0, y: 0, width: 100, height: 1500 };

  it("never assembles history or decodes cold points and reuses unchanged shard measures", () => {
    const book = new InkPageBook();
    book.setFrames(frames(20));
    book.ingestEncodedPages(new Map([[20, encodeInkOps([stroke(2200)])]]));
    const cold = book.cold.get(20)!;
    const assemble = vi.spyOn(book, "assembleOps").mockImplementation(() => { throw new Error("Whole history assembled"); });
    Object.defineProperty(cold.ops[0], "pr", { get() { throw new Error("Cold stroke decoded"); } });
    expect(book.drawContentBottom(frame, 0)).toBe(2201);
    Object.defineProperty(cold.ops[0], "xy", { get() { throw new Error("Cold points rescanned"); } });
    expect(book.drawContentBottom({ ...frame, height: 3000 }, 0)).toBe(2201);
    book.commit(stroke(40));
    expect(book.drawContentBottom(frame, 0)).toBe(2201);
    expect(assemble).not.toHaveBeenCalled();
    expect(book.hot.has(20)).toBe(false);
  });

  it("leaves summarized cold pages outside the frame packed", () => {
    const book = new InkPageBook();
    const encoded = encodeInkOps([stroke(2300, { points: [{ x: 400, y: 2300, pressure: .5 }] })]);
    const cold = lazyEncodedInk(packEncodedInk(encoded), summarizeEncodedInk(encoded));
    book.ingestEncodedPages(new Map([[20, cold]]));
    Object.defineProperty(cold, "ops", { get() { throw new Error("Unpacked another region"); } });
    expect(book.drawContentBottom(frame, 0)).toBe(0);
  });

  it("invalidates measures through replacement, seed, clear, hydration and eviction", () => {
    const book = new InkPageBook();
    book.setFrames(frames(20));
    book.replaceAll([stroke(40), stroke(2200)], { frames: frames(20) });
    expect(book.drawContentBottom(frame, 0)).toBe(2201);
    book.setVisiblePage(20);
    expect(book.drawContentBottom(frame, 0)).toBe(2201);
    book.setVisiblePage(1);
    expect(book.drawContentBottom(frame, 0)).toBe(2201);
    book.markFlushed(book.dirty);
    book.seedCold([[20, encodeInkOps([stroke(2250)])]]);
    expect(book.drawContentBottom(frame, 0)).toBe(2251);
    book.replaceAll([stroke(40)]);
    expect(book.drawContentBottom(frame, 0)).toBe(41);
    book.clear();
    expect(book.drawContentBottom(frame, 0)).toBe(0);
    book.undoOnce();
    expect(book.drawContentBottom(frame, 0)).toBe(41);
  });
});

describe("growth measurement equivalence", () => {
  const frame = { x: 0, y: 0, width: 100, height: 1500 };
  const check = (book: InkPageBook, box = frame, header = 0) => {
    const expected = contentBottomInFrame([], book.assembleOps(), box, header, false);
    expect(book.drawContentBottom(box, header)).toBe(expected);
    expect(book.drawContentBottom(box, header)).toBe(expected);
  };

  it("matches the old history measurement through ink edits, sync and layout changes", () => {
    const book = new InkPageBook();
    const layout = frames(20);
    book.setFrames(layout);
    check(book);
    book.commit(stroke(40)); check(book);
    book.commit(stroke(80)); check(book);
    book.undoOnce(); check(book);
    book.redoOnce(); check(book);
    const erase: InkEraseOp = { kind: "erase", radius: 6, points: [{ x: 15, y: 80, pressure: .5 }] };
    expect(book.strokeErase(erase)).not.toBeNull(); check(book);
    book.undoOnce(); check(book);
    book.redoOnce(); check(book);
    book.commit(stroke(60, { points: [{ x: 15, y: 30, pressure: .5 }, { x: 15, y: 90, pressure: .5 }] }));
    check(book);
    expect(book.partialErase({ ...erase, radius: 15, points: [{ x: 15, y: 90, pressure: .5 }] })).not.toBeNull();
    check(book);
    book.undoOnce(); check(book);
    book.redoOnce(); check(book);
    book.ingestEncodedPages(new Map([[20, encodeInkOps([stroke(layout[19]!.minY + 40)])]]));
    expect(book.hot.has(20)).toBe(false); check(book);
    book.setVisiblePage(20); check(book);
    book.setVisiblePage(1); check(book);
    book.seedCold([[20, encodeInkOps([stroke(layout[19]!.minY + 70)])]]); check(book);
    book.clear(); check(book);
    book.undoOnce(); check(book);
    book.redoOnce(); check(book);
    book.replaceAll([stroke(40), stroke(160)], { frames: layout }); check(book);
    // Page deletion removes its ink; reorder rebins the retained strokes.
    book.replaceAll(book.assembleOps().filter(op => op.points[0]!.y < 100), { preserveIds: true });
    check(book);
    book.setFrames(layout.map((f, i) => ({ ...f, pageId: layout.length - i }))); check(book);
    book.ingestEncodedPages(new Map([[1, encodeInkOps([stroke(90)])]])); check(book);
    for (const box of [{ ...frame, x: 11 }, { ...frame, y: 85 }, { ...frame, width: 9 }, { ...frame, height: 1 }]) {
      check(book, box);
      check(book, box, 50);
    }
    check(book);
  });

  it("invalidates hot measurements and hydrated bytes after a deferred geometry update", () => {
    const book = new InkPageBook();
    book.setFrames(frames(20));
    book.ingestEncodedPages(new Map([[1, encodeInkOps([stroke(40)])]]));
    expect(book.drawContentBottom(frame, 0)).toBe(41);
    const beforeBounds = book.inkBounds()!;
    const revision = book.revision();
    const op = book.hot.get(1)![0]!;
    book.updatePoints(op, stroke(80).points);
    expect(book.revision()).toBe(revision);
    expect(book.dirty.has(1)).toBe(true);
    expect(book.drawContentBottom(frame, 0)).toBe(81);
    expect(book.inkBounds()!.maxY).toBeGreaterThan(beforeBounds.maxY);
    book.setVisiblePage(20);
    expect(book.hot.has(1)).toBe(false);
    expect(book.drawContentBottom(frame, 0)).toBe(81);
    book.setVisiblePage(1);
    expect(book.drawContentBottom(frame, 0)).toBe(81);
    check(book);
  });
});
