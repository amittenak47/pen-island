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
import type { BookMeta } from "./syncState";
import type { InkPageRecord } from "./inkPageStore";

export type RetainedKind = "annotate" | "whiteboard";

export interface RetainedVersion {
  id: string;
  kind: RetainedKind;
  bookId: string;
  /** 1 is the newest. Assigned per book by `versionsByBook`. */
  number: number;
  /** When that version was last edited (its own metadata), 0 when unknown. */
  editedAt: number;
  /** When it was kept; older copies without the stamp use `editedAt`. */
  keptAt: number;
  /** Why it was kept, in the reader's words. */
  reason: string;
  name: string;
  label: string;
  /** The document file this version draws on; "" for whiteboards and text. */
  hash: string;
  /** Its own data and ink, in bytes (the file is counted by the reader of this). */
  dataBytes: number;
  /** Trashed on its own, on this device. */
  trashedAt: number | null;
  /** How to bring it back: a whole book, or an old unsaved branch. */
  restore: "record" | "branch";
}

/** A copy that is not a version on its own: kept with the book, never numbered. */
export interface AttachedCopy { id: string; kind: RetainedKind; bookId: string }

interface Summary { version: Omit<RetainedVersion, "number"> | null; attached: AttachedCopy | null }

const REASONS: Record<string, string> = {
  "document-source-update": "Before updating to a newer file",
  "atomic-book-local-alternative": "This device's version, from a sync choice",
  "atomic-book-hub-alternative": "The hub's version, from a sync choice",
  "retained-restore-with-local-parent": "Before a restore",
  "explicit-recovery-restore": "Before restoring a copy",
  "snapshot-restore": "Before restoring a snapshot",
  "legacy-single-whiteboard": "Older whiteboard format",
  "fallback-branch": "Unsaved branch",
  "explicit-fallback-choice": "Before choosing a saved branch",
};

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The whole book a copy holds, when it holds one (the shape `restoreRetainedRecord` restores). */
export function recordOfCopy(copy: RecoveryCopy): NonNullable<RecoveryCopy["record"]> | null {
  if (copy.record && (copy.type === "record" || copy.type === "conflict")) return copy.record;
  if (copy.type !== "conflict" || !copy.kind || !copy.bookId || !object(copy.content)
    || !object(copy.content.metadata) || !object(copy.content.payload)) return null;
  const prefix = `fnwb:${copy.bookId}:`, children = object(copy.content.children) ? copy.content.children : {};
  return {
    meta: copy.content.metadata as BookMeta, payload: copy.content.payload,
    children: Object.fromEntries(Object.entries(children).map(([key, child]) => [key.startsWith(prefix) ? key.slice(prefix.length) : key, child])),
    ...(Array.isArray(copy.content.ink) ? { ink: copy.content.ink as InkPageRecord[] } : {}),
  };
}

/**
 * Roughly how many bytes a stored value takes: binary at its length, text at
 * its length, the rest by walking it. Close enough to say "2.3 MB".
 */
export function approxBytes(value: unknown, seen = new Set<object>()): number {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  if (typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  let total = 0;
  if (Array.isArray(value)) for (const item of value) total += approxBytes(item, seen);
  else for (const [key, item] of Object.entries(value)) total += key.length + approxBytes(item, seen);
  return total;
}

function summarize(copy: RecoveryCopy): Summary {
  const kind = copy.kind;
  if ((kind !== "annotate" && kind !== "whiteboard") || !copy.bookId) return { version: null, attached: null };
  const source = typeof copy.provenance?.source === "string" ? copy.provenance.source : "";
  const trashedAt = typeof copy.trashedAt === "number" ? copy.trashedAt : null;
  const branch = source === "fallback-branch" && object(copy.content) && typeof copy.content.raw === "string";
  const record = recordOfCopy(copy);
  if (!record && !branch) return { version: null, attached: { id: copy.id, kind, bookId: copy.bookId } };
  const meta = (record?.meta ?? {}) as Record<string, unknown>;
  const text = (key: string) => typeof meta[key] === "string" ? meta[key] as string : "";
  const keptStamp = typeof copy.provenance?.retainedAt === "number" ? copy.provenance.retainedAt : null;
  const editedAt = typeof meta.updatedAt === "number" ? meta.updatedAt : keptStamp ?? 0;
  return { attached: null, version: {
    id: copy.id, kind, bookId: copy.bookId, editedAt, keptAt: keptStamp ?? editedAt,
    reason: REASONS[source] ?? "Kept copy",
    name: text("name") || text("title"), label: text("label"), hash: text("hash"),
    dataBytes: approxBytes(record ? { payload: record.payload, children: record.children, ink: record.ink } : copy.content),
    trashedAt, restore: record ? "record" : "branch",
  } };
}

/*
 * Summaries, read once per copy.
 *
 * A tablet holds hundreds of copies, and reading them whole is half a second
 * of deserializing. Copies never change apart from `trashedAt`, which only
 * this module writes, so a summary stays good for as long as its key exists.
 */
const cache = new Map<string, Summary>();

/** For tests: forget every summary. */
export function resetRetainedVersionCache(): void { cache.clear(); }

async function summaries(): Promise<Summary[]> {
  const keys = await run<IDBValidKey[]>(STORE_SYNC_RECOVERY, "readonly", store => store.getAllKeys());
  const live = new Set(keys.map(String));
  for (const key of [...cache.keys()]) if (!live.has(key)) cache.delete(key);
  const missing = keys.filter(key => !cache.has(String(key)));
  if (missing.length) {
    const rows = await Promise.all(missing.map(key => run<RecoveryCopy | undefined>(STORE_SYNC_RECOVERY, "readonly", store => store.get(key))));
    rows.forEach((row, index) => cache.set(String(missing[index]), row ? summarize(row) : { version: null, attached: null }));
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
