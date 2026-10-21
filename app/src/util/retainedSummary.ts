/**
 * What a retained copy says about itself, worked out from the copy alone.
 *
 * No storage and no app state here, so the same code runs on the page and in
 * `retainedSizes.worker.ts`: reading copies whole is most of a second on a
 * tablet, and the worker is where that happens now.
 */
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
  /** "pdf", "markdown", "web"…; "" for whiteboards. */
  docType: string;
  /** Its own data and ink, in bytes (the file is counted by the reader of this). */
  dataBytes: number;
  /** Trashed on its own, on this device. */
  trashedAt: number | null;
  /** How to bring it back: a whole book, or an old unsaved branch. */
  restore: "record" | "branch";
}

/** A copy that is not a version on its own: kept with the book, never numbered. */
export interface AttachedCopy { id: string; kind: RetainedKind; bookId: string }

export interface Summary { version: Omit<RetainedVersion, "number"> | null; attached: AttachedCopy | null }

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

/** What the Recents rows need from one retained copy, without the copy. */
export function summarize(copy: RecoveryCopy): Summary {
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
    name: text("name") || text("title"), label: text("label"), hash: text("hash"), docType: text("docType"),
    dataBytes: approxBytes(record ? { payload: record.payload, children: record.children, ink: record.ink } : copy.content),
    trashedAt, restore: record ? "record" : "branch",
  } };
}
