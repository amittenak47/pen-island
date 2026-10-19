/**
 * "Export this book once it is open", from a Recents row's export button.
 *
 * Opening a book can land in this tab or another, so the request waits here
 * and whichever workspace finishes opening that book takes it. One at a
 * time, and only for a short while: a request nobody takes in a minute is a
 * stale one, not a promise to export the next time the book happens to open.
 */
export type PendingExportKind = "annotate" | "whiteboard";

const STALE_MS = 60_000;
let pending: { kind: PendingExportKind; id: string; at: number } | null = null;

export function requestExportOnOpen(kind: PendingExportKind, id: string, now = Date.now()): void {
  pending = { kind, id, at: now };
}

/** True once, for the workspace that has this book open. */
export function takePendingExport(kind: PendingExportKind, id: string | null | undefined, now = Date.now()): boolean {
  if (!pending || !id) return false;
  if (now - pending.at > STALE_MS) { pending = null; return false; }
  if (pending.kind !== kind || pending.id !== id) return false;
  pending = null;
  return true;
}
