import type { BookResult } from "../util/bookSync";
import { bookDisplay, bookFailureMessage } from "../util/bookSyncMessages";
import { getStorageItem, LIBRARY_SYNC_RESULT_KEY } from "../util/storageKeys";
import type { BookIdentity } from "../util/syncState";

export interface LibrarySyncRow extends BookIdentity {
  title: string;
  status: BookResult["status"];
  reason: string;
}
export interface LibrarySyncResults { time: number; books: LibrarySyncRow[] }
export const bookSyncFailed = (book: LibrarySyncRow) => book.status !== "synced" && book.status !== "unchanged";
export function loadLibrarySyncResults(): LibrarySyncResults | null {
  try {
    const value = JSON.parse(getStorageItem(LIBRARY_SYNC_RESULT_KEY) ?? "null");
    if (!value || !Number.isFinite(value.time) || !Array.isArray(value.books)) return null;
    if (!value.books.every((book: LibrarySyncRow) => book && ["annotate", "whiteboard", "problem"].includes(book.kind)
      && typeof book.id === "string" && typeof book.title === "string" && typeof book.reason === "string"
      && ["synced", "unchanged", "failed", "needs_choice", "cancelled"].includes(book.status))) return null;
    return value;
  } catch { return null; }
}
/** All passes patch matching identities, retaining books that needed no work. */
export function rememberLibrarySyncResults(books: BookResult[], time = Date.now()): LibrarySyncResults {
  const rows = new Map((loadLibrarySyncResults()?.books ?? []).map(book => [`${book.kind}:${book.id}`, book]));
  for (const book of books) rows.set(`${book.kind}:${book.id}`, {
    kind: book.kind, id: book.id, title: (book.display ?? bookDisplay(book)).title, status: book.status,
    reason: book.status === "needs_choice" ? "Needs your choice" : book.status === "cancelled" ? "Cancelled"
      : book.status === "failed" ? bookFailureMessage(book) : "",
  });
  const result = { time, books: [...rows.values()] };
  try { localStorage.setItem(LIBRARY_SYNC_RESULT_KEY, JSON.stringify(result)); } catch { /* storage unavailable */ }
  return result;
}
export function librarySyncSummary(result: LibrarySyncResults): string {
  const counts = { synced: 0, needs_choice: 0, failed: 0, cancelled: 0 };
  for (const book of result.books) counts[book.status === "unchanged" ? "synced" : book.status]++;
  return [counts.synced && `${counts.synced} synced`, counts.needs_choice && `${counts.needs_choice} need your choice`,
    counts.failed && `${counts.failed} failed`, counts.cancelled && `${counts.cancelled} cancelled`].filter(Boolean).join(" · ") || "0 synced";
}
