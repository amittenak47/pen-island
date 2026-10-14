import type { InkOp, SceneBounds } from "../rasterInk";
import { noteInkTileRaster } from "../inkTileMetrics";
import type { InkTileRasterRequest, InkTileRasterResponse } from "./tileRaster.worker";

type Pending = {
  resolve: (bitmap: ImageBitmap | null) => void;
};

let worker: Worker | null | undefined;
let starting: Promise<Worker | null> | null = null;
let nextId = 1;
// Give dense tiles time to finish, but a lost response must not block paper forever.
const WORKER_TIMEOUT_MS = 120_000;
const pending = new Map<number, Pending>();
// Two recently used histories avoid cloning a dense book on every tile when
// two panes alternate. Weak keys do not retain closed notebooks on the UI side.
let histories = new WeakMap<readonly InkOp[], { id: number; clip: string; tilePx?: number }>();
const resident = new Set<number>();
let nextHistoryId = 1;

function failWorker(error: unknown): void {
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) request.resolve(null);
  pending.clear();
  void error;
}

async function getWorker(): Promise<Worker | null> {
  if (worker !== undefined) return worker;
  if (starting) return starting;
  starting = startWorker();
  return starting;
}

async function startWorker(): Promise<Worker | null> {
  if (typeof Worker === "undefined") {
    worker = null;
    return null;
  }
  try {
    const { default: InkTileRasterWorker } = await import("./tileRaster.worker.ts?worker");
    const next = new InkTileRasterWorker();
    next.onmessage = (event: MessageEvent<InkTileRasterResponse>) => {
      const request = pending.get(event.data.id);
      if (worker !== next || !request) { event.data.bitmap?.close(); return; }
      noteInkTileRaster(event.data.renderMs, event.data.sdfMs);
      request.resolve(event.data.bitmap);
    };
    next.onerror = (event) => {
      if (worker === next) failWorker(event.error ?? new Error(event.message));
    };
    next.onmessageerror = () => {
      if (worker === next) failWorker(new Error("Unreadable ink tile response"));
    };
    worker = next;
  } catch {
    worker = null;
  }
  return worker;
}

export type InkTileRasterJob = {
  ops: readonly InkOp[];
  clip: SceneBounds | null;
  level: number;
  tx: number;
  ty: number;
  tilePx?: number;
  /** Only abort discarded history: the worker may still finish its old tile. */
  signal?: AbortSignal;
};

/** Null permits local fallback unless the caller abandoned this generation via signal. */
export async function rasterInkTileOffThread(
  job: InkTileRasterJob,
): Promise<ImageBitmap | null> {
  if (job.signal?.aborted) return null;
  const target = await getWorker();
  if (!target || target !== worker || job.signal?.aborted) return null;
  const clipKey = JSON.stringify(job.clip);
  let history = histories.get(job.ops);
  if (!history || history.clip !== clipKey || history.tilePx !== job.tilePx) {
    history = { id: nextHistoryId++, clip: clipKey, tilePx: job.tilePx };
    histories.set(job.ops, history);
  }
  if (!resident.has(history.id)) {
    const opsMsg: InkTileRasterRequest = {
      type: "ops",
      historyId: history.id,
      ops: job.ops as InkOp[],
      clip: job.clip,
      tilePx: job.tilePx,
    };
    try { target.postMessage(opsMsg); }
    catch (error) { failWorker(error); return null; }
  }
  resident.delete(history.id);
  resident.add(history.id);
  if (resident.size > 2) resident.delete(resident.values().next().value!);
  const id = nextId++;
  return new Promise<ImageBitmap | null>((resolve) => {
    const signal = job.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => finish(null);
    const finish = (bitmap: ImageBitmap | null) => {
      if (!pending.has(id)) return;
      pending.delete(id);
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(bitmap);
    };
    pending.set(id, { resolve: finish });
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      // End shared ownership before either pane can replay locally.
      if (worker === target) failWorker(new Error("Ink tile worker stopped responding"));
      else finish(null);
    }, WORKER_TIMEOUT_MS);
    const payload: InkTileRasterRequest = {
      type: "render",
      historyId: history.id,
      id,
      level: job.level,
      tx: job.tx,
      ty: job.ty,
    };
    // A slow tile still belongs to the worker. Only failure/termination permits
    // fallback; abort releases a discarded generation without stopping other panes.
    try { target.postMessage(payload); }
    catch (error) { failWorker(error); }
  }).catch(() => null);
}

export function resetInkTileRasterWorkerForTests(): void {
  worker?.terminate();
  worker = undefined;
  starting = null;
  for (const request of pending.values()) request.resolve(null);
  pending.clear();
  nextId = 1;
  histories = new WeakMap();
  resident.clear();
  nextHistoryId = 1;
}
