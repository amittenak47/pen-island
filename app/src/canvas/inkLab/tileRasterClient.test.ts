import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InkOp } from "../rasterInk";
import type { InkTileRasterRequest, InkTileRasterResponse } from "./tileRaster.worker";

const mocks = vi.hoisted(() => ({ instances: [] as Array<{
  onmessage: ((event: MessageEvent<InkTileRasterResponse>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}> }));
vi.mock("./tileRaster.worker.ts?worker", () => ({ default: class {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { mocks.instances.push(this); }
} }));
import { rasterInkTileOffThread, resetInkTileRasterWorkerForTests } from "./tileRasterClient";

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("Worker", class {}); mocks.instances.length = 0; });
afterEach(() => { resetInkTileRasterWorkerForTests(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const job = (ops: InkOp[]) => ({ ops, clip: null, level: 0, tx: 0, ty: 0 });
async function send(ops: InkOp[]) {
  const result = rasterInkTileOffThread(job(ops));
  await vi.waitFor(() => expect(mocks.instances[0]?.postMessage).toHaveBeenCalled());
  // Drain the worker import / request continuation without running timeouts.
  await Promise.resolve();
  return { result };
}
function reply(bitmap: ImageBitmap | null = null) {
  const worker = mocks.instances[0]!;
  const msg = worker.postMessage.mock.calls.at(-1)![0] as InkTileRasterRequest;
  if (msg.type !== "render") throw new Error("Expected render");
  worker.onmessage!({ data: { id: msg.id, bitmap, renderMs: 0, sdfMs: 0 } } as MessageEvent<InkTileRasterResponse>);
}

it("shares concurrent startup and resolves successful requests", async () => {
  const ops: InkOp[] = [];
  const a = rasterInkTileOffThread(job(ops));
  const b = rasterInkTileOffThread(job(ops));
  await vi.waitFor(() => expect(mocks.instances[0]?.postMessage.mock.calls.length).toBe(3));
  expect(mocks.instances).toHaveLength(1);
  const worker = mocks.instances[0]!;
  for (const [msg] of worker.postMessage.mock.calls) {
    if (msg.type === "render") worker.onmessage!({ data: { id: msg.id, bitmap: null, renderMs: 0, sdfMs: 0 } } as MessageEvent<InkTileRasterResponse>);
  }
  await Promise.all([a, b]);
  expect(vi.getTimerCount()).toBe(0);
});

it("reuses two alternating pane histories and resends an evicted history", async () => {
  const a: InkOp[] = [], b: InkOp[] = [], c: InkOp[] = [];
  for (const ops of [a, b, a, b, c, a]) {
    const { result } = await send(ops); reply(); await result;
  }
  const histories = mocks.instances[0]!.postMessage.mock.calls.filter(([msg]) => msg.type === "ops");
  expect(histories).toHaveLength(4);
  expect(histories.map(([msg]) => msg.ops)).toEqual([a, b, c, a]);
});

it("keeps a slow job pending until the worker actually completes it", async () => {
  const { result } = await send([]);
  const resolved = vi.fn();
  void result.then(resolved);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(resolved).not.toHaveBeenCalled();
  const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
  reply(bitmap);
  expect(await result).toBe(bitmap);
  expect(bitmap.close).not.toHaveBeenCalled();
  expect(mocks.instances[0]!.terminate).not.toHaveBeenCalled();
});

it("terminates a failed shared worker before releasing both panes to fall back", async () => {
  const a = await send([]), b = await send([]);
  const worker = mocks.instances[0]!;
  const resolved = vi.fn(() => expect(worker.terminate).toHaveBeenCalledOnce());
  void a.result.then(resolved); void b.result.then(resolved);
  worker.onerror!({ error: new Error("Worker failed") } as ErrorEvent);
  expect(await a.result).toBeNull();
  expect(await b.result).toBeNull();
  expect(resolved).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("closes a bitmap whose caller was released after worker termination", async () => {
  const { result } = await send([]);
  resetInkTileRasterWorkerForTests();
  expect(await result).toBeNull();
  const close = vi.fn();
  reply({ close } as unknown as ImageBitmap);
  expect(close).toHaveBeenCalledOnce();
});

it("terminates an unresponsive shared worker before releasing either pane", async () => {
  const a = await send([]), b = await send([]);
  const worker = mocks.instances[0]!;
  const resolved = vi.fn(() => expect(worker.terminate).toHaveBeenCalledOnce());
  void a.result.then(resolved); void b.result.then(resolved);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(resolved).toHaveBeenCalledTimes(2);
  expect(await a.result).toBeNull();
  expect(await b.result).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  const close = vi.fn();
  reply({ close } as unknown as ImageBitmap);
  expect(close).toHaveBeenCalledOnce();
});

it("releases both panes after an unreadable worker response", async () => {
  const a = await send([]), b = await send([]);
  const worker = mocks.instances[0]!;
  expect(worker.onmessageerror).toBeTypeOf("function");
  worker.onmessageerror!({} as MessageEvent);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(await a.result).toBeNull();
  expect(await b.result).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not post a second pane's request to a worker that failed during the same turn", async () => {
  const { result } = await send([]); reply(); await result;
  const worker = mocks.instances[0]!;
  const posts = worker.postMessage.mock.calls.length;
  worker.postMessage.mockImplementationOnce(() => { throw new Error("Worker failed"); });
  const resolved = vi.fn();
  const a = rasterInkTileOffThread(job([])), b = rasterInkTileOffThread(job([]));
  void a.then(resolved); void b.then(resolved);
  await vi.dynamicImportSettled();
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.postMessage).toHaveBeenCalledTimes(posts + 1);
  expect(resolved).toHaveBeenCalledTimes(2);
  expect(await a).toBeNull();
  expect(await b).toBeNull();
});

it("releases a closed pane's waiter without terminating the other pane's worker", async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const result = rasterInkTileOffThread({ ...job([]), signal: controller.signal });
  const resolved = vi.fn();
  void result.then(resolved);
  await vi.dynamicImportSettled();
  const other = await send([]);
  controller.abort();
  await vi.dynamicImportSettled();
  expect(resolved).toHaveBeenCalledWith(null);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(mocks.instances[0]!.terminate).not.toHaveBeenCalled();
  const closed = mocks.instances[0]!.postMessage.mock.calls
    .map(([msg]) => msg as InkTileRasterRequest).find(msg => msg.type === "render")!;
  const close = vi.fn();
  mocks.instances[0]!.onmessage!({ data: { id: (closed as { id: number }).id,
    bitmap: { close }, renderMs: 0, sdfMs: 0 } } as unknown as MessageEvent<InkTileRasterResponse>);
  expect(close).toHaveBeenCalledOnce();
  reply(); await other.result;
  expect(vi.getTimerCount()).toBe(0);
});
