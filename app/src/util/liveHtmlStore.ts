import { hashMarkdown } from "./annotateStore";

const DATABASE = "whiteboard.liveHtml";
const STORE = "originals";

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) {
        try { db?.close(); } catch { /* A blocked open can finish after its caller has left. */ }
        return;
      }
      settled = true;
      resolve(db);
    };
    try {
      if (typeof indexedDB === "undefined") { finish(null); return; }
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        try { request.result.createObjectStore(STORE); }
        catch {
          try { request.transaction?.abort(); } catch { /* The failed upgrade may already be aborted. */ }
          finish(null);
        }
      };
      request.onsuccess = () => finish(request.result);
      request.onerror = request.onblocked = () => finish(null);
    } catch { finish(null); }
  });
}

/** Live originals are optional device-local companions to the synced still copy. */
export async function putLiveOriginal(key: string, original: string): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDatabase();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db!.transaction(STORE, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
      const store = transaction.objectStore(STORE);
      store.put({ original, savedAt: Date.now() }, key);
      const entries: { key: IDBValidKey; savedAt: number }[] = [];
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          entries.push({ key: cursor.key, savedAt: cursor.value.savedAt });
          cursor.continue();
        } else {
          entries.sort((a, b) => b.savedAt - a.savedAt);
          for (const entry of entries.slice(200)) store.delete(entry.key);
        }
      };
    });
  } catch { /* A still copy remains usable when storage is unavailable. */ }
  finally { try { db?.close(); } catch { /* Live storage is optional. */ } }
}

export async function getLiveOriginal(key: string): Promise<string | null> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDatabase();
    if (!db) return null;
    return await new Promise<string | null>((resolve, reject) => {
      const transaction = db!.transaction(STORE, "readonly");
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
      const request = transaction.objectStore(STORE).get(key);
      request.onsuccess = () => resolve(typeof request.result?.original === "string" ? request.result.original : null);
    });
  } catch { return null; }
  finally { try { db?.close(); } catch { /* Live storage is optional. */ } }
}

/**
 * The original's own hash: what a local HTML file's `localFileHash` already
 * is, at open and after a newer version replaces it.
 *
 * Not the still copy's: that is saved after small rewrites of its own, so the
 * copy in the library never hashed the same as the one the freeze returned,
 * and no original was ever found.
 */
export function liveOriginalKey(original: string): string {
  return hashMarkdown(original);
}
