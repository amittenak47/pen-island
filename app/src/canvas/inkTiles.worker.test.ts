import { createCanvas } from "@napi-rs/canvas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inkTileCanvasPx } from "./inkTileGrid";
import { InkTileCache } from "./inkTiles";
import { paintInkTile } from "./inkLab/tilePaint";
import { resetInkTileRasterWorkerForTests } from "./inkLab/tileRasterClient";
import type { InkTileRasterRequest, InkTileRasterResponse } from "./inkLab/tileRaster.worker";
import type { InkDrawOp, InkOp, ViewportTransform } from "./rasterInk";

const fake = vi.hoisted(() => ({ workers: [] as Array<{
  onmessage: ((event: MessageEvent<InkTileRasterResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}> }));
vi.mock("./inkLab/tileRaster.worker.ts?worker", () => ({ default: class {
  onmessage = null;
  onerror = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { fake.workers.push(this); }
} }));

const caches: InkTileCache[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", class {});
  fake.workers.length = 0;
});
afterEach(() => {
  caches.splice(0).forEach(cache => cache.dispose());
  resetInkTileRasterWorkerForTests();
  vi.useRealTimers(); vi.unstubAllGlobals();
});
const view: ViewportTransform = {
  zoom: 1, scrollX: 0, scrollY: 0, offsetLeft: 0, offsetTop: 0, width: 256, height: 512,
};
const line = (x: number, y: number, endX: number, endY: number, extra: Partial<InkDrawOp> = {}): InkDrawOp => ({
  kind: "draw", color: "#204060", baseWidth: 4, maxFullness: 1,
  pressureClip: 1, pressureSensitive: false,
  points: [{ x, y, pressure: .5 }, { x: endX, y: endY, pressure: .5 }], ...extra,
});
function makeCache(useWorker = true) {
  const schedule: Array<() => void> = [];
  const localPaint = vi.fn((w: number, h: number) => createCanvas(w, h) as unknown as HTMLCanvasElement);
  const cache = new InkTileCache({
    tilePx: 128, useWorker, createCanvas: localPaint, now: () => 0,
    schedule: callback => { schedule.push(callback); return schedule.length; }, cancel: () => {},
  });
  caches.push(cache);
  return { cache, schedule, localPaint };
}
function renders() {
  return fake.workers[0]!.postMessage.mock.calls.map(([msg]) => msg as InkTileRasterRequest)
    .filter((msg): msg is Extract<InkTileRasterRequest, { type: "render" }> => msg.type === "render");
}
function finish(msg = renders().at(-1)!) {
  const worker = fake.workers[0]!;
  const history = worker.postMessage.mock.calls.map(([m]) => m as InkTileRasterRequest)
    .find((m): m is Extract<InkTileRasterRequest, { type: "ops" }> => m.type === "ops" && m.historyId === msg.historyId)!;
  const px = inkTileCanvasPx(history.tilePx);
  const tile = createCanvas(px, px);
  paintInkTile(tile.getContext("2d") as unknown as CanvasRenderingContext2D, { ...history, ...msg });
  const bitmap = Object.assign(tile, { close: vi.fn() });
  worker.onmessage!({ data: { id: msg.id, bitmap, renderMs: 0, sdfMs: 0 } } as unknown as MessageEvent<InkTileRasterResponse>);
  return bitmap;
}
async function tick(schedule: Array<() => void>) {
  schedule.shift()?.();
  await vi.dynamicImportSettled();
}
async function drain(schedule: Array<() => void>) {
  let done = 0;
  for (let step = 0; step < 100; step++) {
    await tick(schedule);
    const next = renders()[done];
    if (next) { finish(next); done++; await vi.dynamicImportSettled(); }
    if (schedule.length === 0 && renders().length === done) return;
  }
  throw new Error("Tile queue did not drain");
}
function denseHistory(): InkOp[] {
  const ops: InkOp[] = [];
  for (let i = 0; i < 220; i++) {
    const x = 5 + (i * 37) % 230, y = 5 + (i * 53) % 490;
    ops.push(line(x, y, 256 - x, y + 12, i % 4 === 0 ? { highlight: true, color: "#f0c020", baseWidth: 9 } : {}));
  }
  ops.push(line(128, -10, 128, 530, {
    points: Array.from({ length: 1800 }, (_, i) => ({ x: 128 + Math.sin(i / 19), y: -10 + i * .3, pressure: .5 })),
  }));
  ops.push(line(0, 128, 256, 128, { highlight: true, color: "#3060ff", baseWidth: 14, highlightTips: false }));
  ops.push({ kind: "erase", radius: 9, points: Array.from({ length: 100 }, (_, i) => ({ x: 128, y: 100 + i * 2, pressure: .5 })) });
  ops.push(line(40, 256, 210, 256, { highlight: true, color: "#ff3030", baseWidth: 7 }));
  return ops.map((op, i) => ({ ...op, id: i + 1, seq: i + 1 }));
}

it("pins dense tile pixels, order, alpha and clipping across a long vertical stroke", async () => {
  const ops = denseHistory();
  const stored = JSON.stringify(ops);
  const clip = { minX: 13, minY: 17, maxX: 243, maxY: 493 };
  const local = makeCache(false), remote = makeCache();
  const a = createCanvas(256, 512), b = createCanvas(256, 512);
  const ctxA = a.getContext("2d"), ctxB = b.getContext("2d");
  for (const { cache } of [local, remote]) { cache.setOps(ops); cache.setClip(clip); }
  local.cache.draw(ctxA as unknown as CanvasRenderingContext2D, view, 1);
  remote.cache.draw(ctxB as unknown as CanvasRenderingContext2D, view, 1);
  await drain(remote.schedule);
  remote.cache.draw(ctxB as unknown as CanvasRenderingContext2D, view, 1);
  const pixels = ctxA.getImageData(0, 0, 256, 512).data;
  expect(ctxB.getImageData(0, 0, 256, 512).data.every((v, i) => v === pixels[i])).toBe(true);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(pixels)));
  expect(Array.from(digest, v => v.toString(16).padStart(2, "0")).join("")).toMatchInlineSnapshot(`"440c9fd4981e1cd8c2a158f9eb22ee9c31e8bed00d88cde98eadc90905fc8018"`);
  expect(ctxA.getImageData(12, 128, 1, 1).data[3]).toBe(0);
  expect(ctxA.getImageData(244, 256, 1, 1).data[3]).toBe(0);
  expect(ctxA.getImageData(128, 10, 1, 1).data[3]).toBe(0);
  expect(ctxA.getImageData(128, 400, 1, 1).data[3]).toBeGreaterThan(0);
  expect([...pixels].some((v, i) => i % 4 === 3 && v > 0 && v < 255)).toBe(true);
  expect(remote.cache.covered).toBe(true);
  expect(remote.localPaint).not.toHaveBeenCalled();
  expect(JSON.stringify(ops)).toBe(stored);
});

it("discards unfinished old-page pixels before painting a new page", async () => {
  const { cache, schedule, localPaint } = makeCache();
  const canvas = createCanvas(256, 512), ctx = canvas.getContext("2d");
  cache.setOps([line(20, 64, 110, 64)]);
  cache.draw(ctx as unknown as CanvasRenderingContext2D, view, 1);
  await tick(schedule);
  const old = renders()[0]!;
  cache.setOps([line(20, 196, 110, 196)]);
  cache.draw(ctx as unknown as CanvasRenderingContext2D, view, 1);
  expect(cache.covered).toBe(false);
  const bitmap = finish(old);
  await vi.dynamicImportSettled();
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(cache.size).toBe(0);
  // Drain only the new generation's jobs; the first response was discarded.
  let done = 1;
  for (let step = 0; step < 30; step++) {
    await tick(schedule);
    if (renders()[done]) { finish(renders()[done]!); done++; await vi.dynamicImportSettled(); }
    cache.draw(ctx as unknown as CanvasRenderingContext2D, view, 1);
    expect(ctx.getImageData(60, 64, 1, 1).data[3]).toBe(0);
    if (cache.covered) break;
  }
  expect(cache.covered).toBe(true);
  expect(ctx.getImageData(60, 196, 1, 1).data[3]).toBeGreaterThan(0);
  expect(localPaint).not.toHaveBeenCalled();
});
