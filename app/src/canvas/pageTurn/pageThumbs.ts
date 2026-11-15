/**
 * Small pictures of a text note's pages, kept on disk, for the pages a hand
 * flicks past.
 *
 * A turn flicked through has no time to copy the pages it goes past (see
 * `liveSpread` in PageTurn), and with nothing else to show they turned over
 * as plain paper: black in a dark palette. These stand in for them. They are
 * taken while the reader rests, one page at a time, at a fraction of the
 * screen's resolution: the page is moving, and blurred it still reads as
 * that page going by.
 *
 * A book here is one note in one layout and palette: the same pages, cut at
 * the same places, in the same colours. Its pictures are kept on disk, so a
 * note pictured once has them the next time it opens, in any tab. Once all
 * books together pass `DISK_BUDGET`, the ones read least recently go.
 *
 * In memory each book keeps only what its pages are and which ink each was
 * taken with; pixels are decoded for the pages around where a tab reads
 * (`decodeThumbsAround`), and at most `DECODED_MAX` of them in all, so a
 * dozen notes open keep no more than one window's worth.
 */

import type { PageFrame } from "../inkPageIndex";

export const PAGE_THUMB_DB = "whiteboard.pageThumbs";
const BOOKS = "books";
const PIXELS = "pixels";

/** Thumb pixels per CSS px of the page as shown: half the screen's, before its own pixel ratio. */
export const THUMB_PX_PER_CSS = 0.5;
/** All books' pictures together, on disk. */
const DISK_BUDGET = 48 * 1024 * 1024;
/** Decoded pictures held, all tabs together: about 500 KB each on a tablet. */
const DECODED_MAX = 40;
/** Pages decoded ahead of the page read, the way the last turn went, and behind it. */
const DECODE_AHEAD = 24;
const DECODE_BEHIND = 12;
const ENCODE_TYPE = "image/webp";
const ENCODE_QUALITY = 0.8;

/** What a page's picture was taken of, as kept with its book. */
interface PageRecord {
  /** The page's ink when it was taken (`BoardHandle.inkSignatureIn`). */
  ink: string;
  bytes: number;
  type: string;
}

interface BookRecord {
  usedAt: number;
  bytes: number;
  pages: Record<string, PageRecord>;
}

type Picture = (ImageBitmap | HTMLCanvasElement) & { width: number; height: number };

export interface ThumbBook {
  key: string;
  pages: Map<number, PageRecord>;
  pictures: Map<number, Picture>;
  decoding: Set<number>;
  /** Settles once the book's record has been read from disk (or found missing). */
  loaded: Promise<void>;
  ready: boolean;
}

/** How pictures become bytes and back: swapped out in tests, where jsdom has neither. */
export interface ThumbCodec {
  encode(canvas: HTMLCanvasElement): Promise<{ data: ArrayBuffer; type: string } | null>;
  decode(data: ArrayBuffer, type: string): Promise<Picture | null>;
}

const browserCodec: ThumbCodec = {
  encode: (canvas) => new Promise((resolve) => {
    if (typeof canvas.toBlob !== "function") { resolve(null); return; }
    try {
      canvas.toBlob((blob) => {
        if (!blob) { resolve(null); return; }
        blob.arrayBuffer().then((data) => resolve({ data, type: blob.type || ENCODE_TYPE }), () => resolve(null));
      }, ENCODE_TYPE, ENCODE_QUALITY);
    } catch {
      resolve(null);
    }
  }),
  decode: async (data, type) => {
    if (typeof createImageBitmap !== "function") return null;
    try {
      return await createImageBitmap(new Blob([data], { type }));
    } catch {
      return null;
    }
  },
};

let codec = browserCodec;
const books = new Map<string, ThumbBook>();
/** Decoded pictures, least recently wanted first, as `book\x1findex`. */
const decodedOrder: string[] = [];
let dbPromise: Promise<IDBDatabase> | null = null;
let prunedThisSession = false;

export function setThumbCodecForTests(next: ThumbCodec | null): void {
  codec = next ?? browserCodec;
}

/** Tests that stub IndexedDB must drop the open database and every book. */
export function resetPageThumbsForTests(): void {
  dbPromise = null;
  prunedThisSession = false;
  for (const book of books.values()) for (const picture of book.pictures.values()) closePicture(picture);
  books.clear();
  decodedOrder.length = 0;
}

function mix(h: number, n: number): number {
  return Math.imul(h ^ n, 2654435761) >>> 0;
}

/**
 * The book a note's pages make: its content, where its pages are cut and how
 * wide and tall they are, and the palette they are drawn in. Null without a
 * note to name or pages to show.
 */
export function thumbBookKey(
  doc: string | null | undefined,
  frames: readonly PageFrame[],
  box: { minX: number; maxX: number; minY: number; maxY: number } | null,
  palette: string,
): string | null {
  if (!doc || frames.length === 0 || !box) return null;
  let h = mix(0x9e3779b9, frames.length);
  for (const f of frames) h = mix(mix(h, Math.round(f.minY)), Math.round(f.maxY));
  const size = `${Math.round(box.maxX - box.minX)}x${Math.round(box.maxY - box.minY)}`;
  let p = 0x811c9dc5;
  for (let i = 0; i < palette.length; i += 1) p = mix(p, palette.charCodeAt(i));
  return `${doc}\x1f${frames.length}.${size}.${h.toString(36)}\x1f${p.toString(36)}`;
}

/**
 * The store, at whatever version it is. One found without its stores (made
 * by something that only opened it, a probe from DevTools say) is opened one
 * version on, which makes them: opened as it was, no picture could be kept.
 */
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const open = (version?: number) => new Promise<IDBDatabase>((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(PAGE_THUMB_DB) : indexedDB.open(PAGE_THUMB_DB, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BOOKS)) db.createObjectStore(BOOKS);
      if (!db.objectStoreNames.contains(PIXELS)) db.createObjectStore(PIXELS);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another window making the stores: let it, and open again after.
      db.onversionchange = () => {
        db.close();
        if (dbPromise === opened) dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("could not open the page picture store"));
    request.onblocked = () => reject(new Error("another window holds the page picture store open"));
  });
  const opened: Promise<IDBDatabase> = (async () => {
    if (typeof indexedDB === "undefined") throw new Error("this device has no IndexedDB");
    const db = await open();
    if (db.objectStoreNames.contains(BOOKS) && db.objectStoreNames.contains(PIXELS)) return db;
    const next = db.version + 1;
    db.close();
    return open(next);
  })().catch((cause: unknown) => {
    if (dbPromise === opened) dbPromise = null;
    throw cause;
  });
  dbPromise = opened;
  return opened;
}

function transaction(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("page picture transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("page picture transaction failed"));
    work(tx);
  });
}

const pixelKey = (book: string, index: number) => `${book}\x1f${index}`;

/**
 * The book for `key`, read from disk the first time it is asked for. A
 * book's pictures are usable once `ready`: until then it has none.
 */
export function openThumbBook(key: string): ThumbBook {
  const known = books.get(key);
  if (known) return known;
  const book: ThumbBook = { key, pages: new Map(), pictures: new Map(), decoding: new Set(), loaded: Promise.resolve(), ready: false };
  books.set(key, book);
  book.loaded = (async () => {
    try {
      const db = await openDb();
      let record: BookRecord | undefined;
      await transaction(db, [BOOKS], "readwrite", (tx) => {
        const store = tx.objectStore(BOOKS);
        const get = store.get(key);
        get.onsuccess = () => {
          record = get.result as BookRecord | undefined;
          // Read now: it goes last when the disk is pruned.
          if (record) store.put({ ...record, usedAt: Date.now() }, key);
        };
      });
      for (const [index, page] of Object.entries(record?.pages ?? {})) {
        // Pages taken while the book was being read in are newer.
        if (!book.pages.has(Number(index))) book.pages.set(Number(index), page);
      }
    } catch {
      /* no disk: pictures last as long as the session */
    }
    book.ready = true;
    if (!prunedThisSession) {
      prunedThisSession = true;
      void pruneThumbBooks();
    }
  })();
  return book;
}

/** The ink page `index` was pictured with, or null if it has no picture. */
export function thumbInk(key: string, index: number): string | null {
  return books.get(key)?.pages.get(index)?.ink ?? null;
}

/** Page `index`'s picture, if it is decoded: what a turn can show at once. */
export function thumbPicture(key: string | null, index: number): Picture | null {
  if (!key) return null;
  return books.get(key)?.pictures.get(index) ?? null;
}

function closePicture(picture: Picture): void {
  if ("close" in picture && typeof picture.close === "function") picture.close();
}

function noteDecoded(key: string, index: number): void {
  const id = pixelKey(key, index);
  const at = decodedOrder.indexOf(id);
  if (at >= 0) decodedOrder.splice(at, 1);
  decodedOrder.push(id);
}

function dropDecoded(book: ThumbBook, index: number): void {
  const picture = book.pictures.get(index);
  if (!picture) return;
  book.pictures.delete(index);
  closePicture(picture);
  const at = decodedOrder.indexOf(pixelKey(book.key, index));
  if (at >= 0) decodedOrder.splice(at, 1);
}

/** Over `DECODED_MAX`: let go of the pictures wanted least recently, never one of `keep`'s. */
function trimDecoded(keep: ThumbBook, lo: number, hi: number): void {
  for (let i = 0; decodedOrder.length > DECODED_MAX && i < decodedOrder.length;) {
    const id = decodedOrder[i]!;
    const sep = id.lastIndexOf("\x1f");
    const book = books.get(id.slice(0, sep));
    const index = Number(id.slice(sep + 1));
    if (book === keep && index >= lo && index <= hi) { i += 1; continue; }
    if (book) dropDecoded(book, index);
    else decodedOrder.splice(i, 1);
  }
}

/**
 * Have the pictures of the pages around `at` decoded, more of them the way
 * the reader is `heading`, and let go of this book's others. Reads from disk
 * and decodes off the main thread; a page not decoded yet simply has none.
 */
/** The pages kept decoded around page `at`: more of them the way the reader is heading. */
export function thumbWindow(at: number, heading: 1 | -1 = 1): { lo: number; hi: number } {
  return {
    lo: at - (heading > 0 ? DECODE_BEHIND : DECODE_AHEAD),
    hi: at + (heading > 0 ? DECODE_AHEAD : DECODE_BEHIND),
  };
}

export function decodeThumbsAround(key: string, at: number, heading: 1 | -1 = 1): Promise<void> {
  const book = openThumbBook(key);
  const { lo, hi } = thumbWindow(at, heading);
  return book.loaded.then(async () => {
    for (const index of [...book.pictures.keys()]) {
      if (index < lo || index > hi) dropDecoded(book, index);
      else noteDecoded(key, index);
    }
    const wanted = [...book.pages.keys()]
      .filter((i) => i >= lo && i <= hi && !book.pictures.has(i) && !book.decoding.has(i))
      .sort((a, b) => Math.abs(a - at) - Math.abs(b - at));
    if (wanted.length === 0) return;
    for (const i of wanted) book.decoding.add(i);
    let read = new Map<number, ArrayBuffer>();
    try {
      const db = await openDb();
      await transaction(db, [PIXELS], "readonly", (tx) => {
        const store = tx.objectStore(PIXELS);
        for (const i of wanted) {
          const get = store.get(pixelKey(key, i));
          // Not `instanceof`: a buffer read back can come from another realm.
          get.onsuccess = () => {
            if (Object.prototype.toString.call(get.result) === "[object ArrayBuffer]") read.set(i, get.result as ArrayBuffer);
          };
        }
      });
    } catch {
      read = new Map();
    }
    await Promise.all(wanted.map(async (i) => {
      const data = read.get(i);
      const page = book.pages.get(i);
      const picture = data && page ? await codec.decode(data, page.type) : null;
      book.decoding.delete(i);
      // Retaken while it decoded, or out of the window since: not wanted.
      if (!picture) return;
      if (book.pictures.has(i) || book.pages.get(i) !== page || books.get(key) !== book) {
        closePicture(picture);
        return;
      }
      book.pictures.set(i, picture);
      noteDecoded(key, i);
    }));
    trimDecoded(book, lo, hi);
  });
}

/**
 * A picture of page `index` at thumb size, for the book: written to disk
 * with the ink it shows, and kept decoded if it is near where the reader
 * is (`near`), for the turns about to need it.
 */
export async function keepThumb(key: string, index: number, picture: HTMLCanvasElement, ink: string, near = true): Promise<void> {
  const book = openThumbBook(key);
  await book.loaded;
  const encoded = await codec.encode(picture);
  dropDecoded(book, index);
  if (near || !encoded) {
    book.pictures.set(index, picture as Picture);
    noteDecoded(key, index);
    trimDecoded(book, index, index);
  }
  if (!encoded) {
    // Shown this session, never kept: taken again next time.
    book.pages.delete(index);
    return;
  }
  const page: PageRecord = { ink, bytes: encoded.data.byteLength, type: encoded.type };
  book.pages.set(index, page);
  try {
    const db = await openDb();
    await transaction(db, [BOOKS, PIXELS], "readwrite", (tx) => {
      const store = tx.objectStore(BOOKS);
      const get = store.get(key);
      get.onsuccess = () => {
        const record = (get.result as BookRecord | undefined) ?? { usedAt: Date.now(), bytes: 0, pages: {} };
        const before = record.pages[String(index)]?.bytes ?? 0;
        record.pages[String(index)] = page;
        record.bytes = Math.max(0, record.bytes - before) + page.bytes;
        record.usedAt = Date.now();
        store.put(record, key);
        tx.objectStore(PIXELS).put(encoded.data, pixelKey(key, index));
      };
    });
  } catch {
    /* quota or no disk: this session still shows it */
  }
}

/**
 * Keep all books under `DISK_BUDGET`: the ones read least recently go
 * first, never one open now.
 */
export async function pruneThumbBooks(budget = DISK_BUDGET): Promise<void> {
  try {
    const db = await openDb();
    const all: { key: string; record: BookRecord }[] = [];
    await transaction(db, [BOOKS], "readonly", (tx) => {
      const cursor = tx.objectStore(BOOKS).openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        all.push({ key: String(at.key), record: at.value as BookRecord });
        at.continue();
      };
    });
    let total = all.reduce((sum, { record }) => sum + (record.bytes || 0), 0);
    if (total <= budget) return;
    const doomed: string[] = [];
    for (const { key, record } of all.sort((a, b) => a.record.usedAt - b.record.usedAt)) {
      if (total <= budget) break;
      if (books.has(key)) continue;
      doomed.push(key);
      total -= record.bytes || 0;
    }
    if (doomed.length === 0) return;
    await transaction(db, [BOOKS, PIXELS], "readwrite", (tx) => {
      for (const key of doomed) {
        tx.objectStore(BOOKS).delete(key);
        tx.objectStore(PIXELS).delete(IDBKeyRange.bound(`${key}\x1f`, `${key}\x1f￿`));
      }
    });
  } catch {
    /* nothing to prune without a disk */
  }
}

/**
 * The order to picture a book's pages in from page `at`: its spread (or the
 * page), then two spreads the way the reader is heading for each one back.
 */
export function thumbOrder(at: number, count: number, heading: 1 | -1, step: 1 | 2): number[] {
  const out: number[] = [];
  const start = step === 2 ? at - (at % 2) : at;
  const push = (from: number) => {
    for (let i = from; i < from + step; i += 1) if (i >= 0 && i < count) out.push(i);
  };
  push(start);
  let ahead = start + heading * step;
  let back = start - heading * step;
  const inRange = (i: number) => i + step > 0 && i < count;
  while (inRange(ahead) || inRange(back)) {
    for (let n = 0; n < 2 && inRange(ahead); n += 1) {
      push(ahead);
      ahead += heading * step;
    }
    if (inRange(back)) {
      push(back);
      back -= heading * step;
    }
  }
  return out;
}

/** `picture` drawn at `width` by `height`, smoothed: a thumb from a full picture. */
export function shrinkPicture(picture: CanvasImageSource, width: number, height: number): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
  return canvas;
}
