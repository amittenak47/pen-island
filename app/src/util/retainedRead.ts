/**
 * Reading retained copies and books for their sizes: the part that is slow.
 *
 * A copy is a whole book, and so is the book itself. Reading one means
 * deserializing all of it, and the Recents rows read every copy and every
 * book on their first open after launch: most of a second on a tablet, spent
 * exactly while the reader's finger was holding Open. This module touches only
 * IndexedDB and plain data, so it runs in `retainedSizes.worker.ts`; the page
 * calls it directly only where no worker can start.
 */
import { openDb, STORE_CONTENT, STORE_INK_PAGES, STORE_SYNC_RECOVERY } from "./idb";
import { approxBytes, summarize, type RetainedKind, type Summary } from "./retainedSummary";
import type { RecoveryCopy } from "./syncRecovery";

/** `inkPageStore`'s key separator: ink pages are `${docKey}\u001f${pageId}`. */
const INK_KEY_SEP = "\u001f";

/** The summary of each copy under `keys`, in order; one read-only transaction. */
export async function readSummaries(keys: readonly IDBValidKey[]): Promise<Summary[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SYNC_RECOVERY, "readonly");
    const store = tx.objectStore(STORE_SYNC_RECOVERY);
    const out: Summary[] = new Array(keys.length);
    keys.forEach((key, index) => {
      const request = store.get(key);
      // Summarized as each one arrives, so only one copy is held at a time.
      request.onsuccess = () => {
        const row = request.result as RecoveryCopy | undefined;
        out[index] = row ? summarize(row) : { version: null, attached: null };
      };
    });
    tx.oncomplete = () => resolve(out);
    tx.onabort = () => reject(tx.error ?? new Error("retained copies could not be read"));
  });
}

/**
 * A book's own data on this device, in bytes: its saved record, its ink, and
 * for a document its scratch boards and their ink. Not its file.
 */
export async function readBookData(kind: RetainedKind, id: string): Promise<number> {
  const db = await openDb();
  const docKey = `${kind === "annotate" ? "md" : "wb"}:${id}`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CONTENT, STORE_INK_PAGES], "readonly");
    let bytes = 0;
    const sum = (store: IDBObjectStore, range: IDBKeyRange) => {
      const request = store.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        bytes += approxBytes(cursor.value);
        cursor.continue();
      };
    };
    const content = tx.objectStore(STORE_CONTENT);
    const ink = tx.objectStore(STORE_INK_PAGES);
    const record = content.get(id);
    record.onsuccess = () => { bytes += approxBytes(record.result); };
    sum(ink, IDBKeyRange.bound(`${docKey}${INK_KEY_SEP}`, `${docKey}${INK_KEY_SEP}￿`));
    if (kind === "annotate") {
      // Scratch boards and their ink sit under the book's prefix in both stores.
      const prefix = `fnwb:${id}:`;
      for (const store of [content, ink]) sum(store, IDBKeyRange.bound(prefix, `${prefix}￿`));
    }
    tx.oncomplete = () => resolve(bytes);
    tx.onabort = () => reject(tx.error ?? new Error("book size could not be read"));
  });
}
