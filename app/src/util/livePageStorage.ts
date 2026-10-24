/**
 * A live local page's own `localStorage`, kept by the app per document.
 *
 * The page runs in a sandboxed frame with an opaque origin, where the real
 * `localStorage` throws, so a page that remembers its last tab or step lost
 * it on every open. The frame gets a stand-in seeded from here
 * (`liveHtmlSrcdoc`), and each change comes back as a message and is kept
 * under the document's id: through reloads, "Update to this file" (same id)
 * and app restarts. Device-local, like the reader's scroll position.
 */

const PREFIX = "lc-live-page-storage:";

/** Characters across all keys and values, per document. Far above what a page's preferences need. */
export const LIVE_PAGE_STORAGE_LIMIT = 512 * 1024;

export type LivePageStorage = Record<string, string>;

export function livePageStorageSize(map: LivePageStorage): number {
  let size = 0;
  for (const [key, value] of Object.entries(map)) size += key.length + value.length;
  return size;
}

/** A plain map of strings within the limit: what a page may hand back. */
export function isLivePageStorage(value: unknown): value is LivePageStorage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  return Object.values(value).every((item) => typeof item === "string")
    && livePageStorageSize(value as LivePageStorage) <= LIVE_PAGE_STORAGE_LIMIT;
}

export function readLivePageStorage(id: string): LivePageStorage {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREFIX + id) ?? "{}");
    return isLivePageStorage(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

/** False when the map is not one, or the app's own storage refused it. */
export function writeLivePageStorage(id: string, map: unknown): boolean {
  if (!isLivePageStorage(map)) return false;
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(PREFIX + id);
    else localStorage.setItem(PREFIX + id, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}
