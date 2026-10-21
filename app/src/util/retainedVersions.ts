/**
 * Retained copies as numbered versions of a book, for the Recents rows.
 *
 * A retained copy is a whole earlier version this device kept by itself: the
 * one a sync choice replaced, the one before "update to the newer file", the
 * one a restore replaced. They live only on this device (STORE_SYNC_RECOVERY)
 * and never sync. Here they get numbers (1 = the newest), a reason, a date, a
 * size, and a trash state:
 *
 * - A copy can be trashed on its own (`trashedAt`, this device only), and then
 *   deleted for good. That touches that copy and nothing else.
 * - A book in the trash takes its copies with it, by derivation rather than by
 *   writing a flag on each: a copy is in the trash when it was trashed itself,
 *   or when its book is (or is gone). Deleting the book for good deletes them.
 *
 * Only versions that can be restored are numbered. The bookkeeping rows a sync
 * conflict or an old format leaves (`attached`) belong to the book too: they
 * go when the book is deleted for good, and are otherwise left alone.
 */
import { run, STORE_SYNC_RECOVERY, withStore } from "./idb";
import { lengthFromHash } from "./docBytes";
import type { RecoveryCopy } from "./syncRecovery";
import { readBookData, readSummaries } from "./retainedRead";
import type { AttachedCopy, RetainedKind, RetainedVersion, Summary } from "./retainedSummary";
import type { RetainedSizesReply } from "./retainedSizes.worker";

export type { AttachedCopy, RetainedKind, RetainedVersion } from "./retainedSummary";
export { approxBytes, recordOfCopy } from "./retainedSummary";

/*
 * The reading, in a worker (`retainedSizes.worker.ts`).
 *
 * One worker for a burst of requests, let go once it has been idle a while.
 * Where none can start (tests, an old WebView) or it fails, the same reading
 * runs here instead: slower to look at, never wrong.
 */
type WorkerAsk =
  | { op: "summaries"; keys: IDBValidKey[] }
  | { op: "book"; kind: RetainedKind; bookId: string };
const WORKER_IDLE_MS = 10_000;
let sizesWorker: Worker | null = null;
let sizesWorkerIdle: ReturnType<typeof setTimeout> | null = null;
let nextAsk = 0;
const asked = new Map<number, { resolve: (reply: unknown) => void; reject: (cause: Error) => void }>();

function dropWorker(cause: Error): void {
  sizesWorker?.terminate();
  sizesWorker = null;
  for (const pending of asked.values()) pending.reject(cause);
  asked.clear();
}

function askWorker<T>(ask: WorkerAsk): Promise<T> {
  if (typeof Worker === "undefined") return Promise.reject(new Error("no worker"));
  if (!sizesWorker) {
    try {
      sizesWorker = new Worker(new URL("./retainedSizes.worker.ts", import.meta.url), { type: "module" });
    } catch (cause) {
      return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
    sizesWorker.onmessage = (event: MessageEvent<RetainedSizesReply>) => {
      const pending = asked.get(event.data.id);
      if (!pending) return;
      asked.delete(event.data.id);
      if ("error" in event.data) pending.reject(new Error(event.data.error));
      else pending.resolve(event.data);
      if (asked.size === 0) {
        if (sizesWorkerIdle) clearTimeout(sizesWorkerIdle);
        sizesWorkerIdle = setTimeout(() => { if (asked.size === 0) dropWorker(new Error("idle")); }, WORKER_IDLE_MS);
      }
    };
    sizesWorker.onerror = (event) => dropWorker(new Error(event.message || "retained sizes worker failed"));
  }
  if (sizesWorkerIdle) { clearTimeout(sizesWorkerIdle); sizesWorkerIdle = null; }
  const id = ++nextAsk;
  return new Promise<T>((resolve, reject) => {
    asked.set(id, { resolve: resolve as (reply: unknown) => void, reject });
    sizesWorker!.postMessage({ id, ...ask });
  });
}

/*
 * Summaries, read once per copy.
 *
 * A tablet holds hundreds of copies, and reading them whole is half a second
 * of deserializing. Copies never change apart from `trashedAt`, which only
 * this module writes, so a summary stays good for as long as its key exists.
 */
const cache = new Map<string, Summary>();

/** For tests: forget every summary and size, and let the worker go. */
export function resetRetainedVersionCache(): void {
  cache.clear();
  bookSizes.clear();
  if (sizesWorkerIdle) { clearTimeout(sizesWorkerIdle); sizesWorkerIdle = null; }
  dropWorker(new Error("reset"));
}

async function summaries(): Promise<Summary[]> {
  const keys = await run<IDBValidKey[]>(STORE_SYNC_RECOVERY, "readonly", store => store.getAllKeys());
  const live = new Set(keys.map(String));
  for (const key of [...cache.keys()]) if (!live.has(key)) cache.delete(key);
  const missing = keys.filter(key => !cache.has(String(key)));
  if (missing.length) {
    const read = await askWorker<{ summaries: Summary[] }>({ op: "summaries", keys: missing })
      .then(reply => reply.summaries, () => readSummaries(missing));
    read.forEach((summary, index) => cache.set(String(missing[index]), summary));
  }
  return keys.map(key => cache.get(String(key))!).filter(Boolean);
}

/**
 * Every book's numbered versions and attached rows, for one kind.
 *
 * 1 is the copy kept last: keeping another shifts the rest forward (1 becomes
 * 2), and none replaces another. A pick in the list follows the copy by id.
 */
export async function versionsByBook(kind: RetainedKind): Promise<{
  versions: Map<string, RetainedVersion[]>;
  attached: Map<string, AttachedCopy[]>;
}> {
  const versions = new Map<string, RetainedVersion[]>();
  const attached = new Map<string, AttachedCopy[]>();
  for (const summary of await summaries()) {
    if (summary.version?.kind === kind) versions.set(summary.version.bookId, [...versions.get(summary.version.bookId) ?? [], { ...summary.version, number: 0 }]);
    if (summary.attached?.kind === kind) attached.set(summary.attached.bookId, [...attached.get(summary.attached.bookId) ?? [], summary.attached]);
  }
  for (const rows of versions.values()) {
    rows.sort((a, b) => b.keptAt - a.keptAt || b.editedAt - a.editedAt || a.id.localeCompare(b.id));
    rows.forEach((row, index) => { row.number = index + 1; });
  }
  return { versions, attached };
}

/**
 * What a version takes on this device: its data and ink, plus its file when
 * that file is not the one the book draws on now (only then does keeping
 * the copy keep a file the book would not).
 */
export function versionBytes(version: RetainedVersion, currentHash: string | undefined): number {
  const file = version.hash && version.hash !== currentHash ? lengthFromHash(version.hash) ?? 0 : 0;
  return version.dataBytes + file;
}

async function setTrashed(id: string, trashedAt: number | null): Promise<void> {
  await withStore(STORE_SYNC_RECOVERY, "readwrite", store => {
    const request = store.get(id);
    request.onsuccess = () => {
      const row = request.result as RecoveryCopy | undefined;
      if (!row) return;
      const next: RecoveryCopy = { ...row };
      if (trashedAt === null) delete next.trashedAt; else next.trashedAt = trashedAt;
      store.put(next, id);
    };
  });
  const summary = cache.get(id);
  if (summary?.version) cache.set(id, { ...summary, version: { ...summary.version, trashedAt } });
}

/** Move one copy to the trash (this device only). Its book and other copies are untouched. */
export function trashRetainedCopy(id: string): Promise<void> { return setTrashed(id, Date.now()); }
/** Take one copy back out of the trash. */
export function untrashRetainedCopy(id: string): Promise<void> { return setTrashed(id, null); }

/** Delete copies for good. Only these rows go; the book and its file stay. */
export async function deleteRetainedCopies(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  await withStore(STORE_SYNC_RECOVERY, "readwrite", store => { for (const id of ids) store.delete(id); });
  for (const id of ids) cache.delete(id);
}

/** A book deleted for good takes every copy it had, numbered or attached. */
export async function deleteBookRetainedCopies(kind: RetainedKind, bookId: string): Promise<void> {
  const { versions, attached } = await versionsByBook(kind);
  await deleteRetainedCopies([...(versions.get(bookId) ?? []), ...(attached.get(bookId) ?? [])].map(row => row.id));
}

/*
 * What the current book takes on this device: its saved data, its ink, its
 * scratch boards, and its file. Read once per edit (`updatedAt`): opening the
 * list must not re-read every book's handwriting each time.
 */
const bookSizes = new Map<string, { updatedAt: number; bytes: number }>();

export async function bookBytes(kind: RetainedKind, id: string, updatedAt: number, hash?: string): Promise<number> {
  const key = `${kind}:${id}`;
  const cached = bookSizes.get(key);
  if (cached && cached.updatedAt === updatedAt) return cached.bytes + (hash ? lengthFromHash(hash) ?? 0 : 0);
  const data = await askWorker<{ bytes: number }>({ op: "book", kind, bookId: id })
    .then(reply => reply.bytes, () => readBookData(kind, id));
  bookSizes.set(key, { updatedAt, bytes: data });
  return data + (hash ? lengthFromHash(hash) ?? 0 : 0);
}

/** "2.3 MB", "640 KB", "12 B". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
