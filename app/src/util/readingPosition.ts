/**
 * Where a reader is in a document, saved as they read.
 *
 * The page a document reopens on lived only in its saved session, and a
 * session is saved when something in it changes — ink, notes, a rename —
 * not when a page is turned. Reading without writing, then the app being
 * killed in the background, brought the book back pages behind. This is
 * the reading place alone, small and saved on every settled turn.
 *
 * A PDF keeps its page number. A text document (markdown, code, text, EPUB)
 * has no pages of its own, so it keeps a place in its scene instead: see
 * {@link ReadingPlace}. A note that is only ever read has no session at all,
 * so for it this is the only record of where it was.
 *
 * Saved on this device, by document id; the most recent few hundred kept.
 * Never synced: the session's own view keys are device-local too.
 */

const KEY = "lc-reading-page.v1";
const PLACE_KEY = "lc-reading-place.v1";
const KEEP = 300;

type Entry = { at: number };
type Places = Record<string, { page: number; at: number }>;

function load<T extends Entry>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function store<T extends Entry>(key: string, entries: Record<string, T>): void {
  const ids = Object.keys(entries);
  if (ids.length > KEEP) {
    ids
      .sort((a, b) => entries[a]!.at - entries[b]!.at)
      .slice(0, ids.length - KEEP)
      .forEach((id) => delete entries[id]);
  }
  try {
    localStorage.setItem(key, JSON.stringify(entries));
  } catch {
    /* storage full or unavailable: the session's own place still stands */
  }
}

/**
 * The page this document was last read at here, or 0 — when that reading is
 * newer than `savedAt` (the session's own last save, which keeps its page
 * when it was saved after the reading).
 */
export function loadReadingPage(docId: string | null | undefined, savedAt = 0): number {
  if (!docId) return 0;
  const place = load<Places[string]>(KEY)[docId];
  const page = Math.floor(Number(place?.page));
  if (!Number.isFinite(page) || page < 1) return 0;
  return Number(place?.at) > savedAt ? page : 0;
}

export function saveReadingPage(docId: string | null | undefined, page: number): void {
  if (!docId || !(page >= 1)) return;
  const places = load<Places[string]>(KEY);
  if (places[docId]?.page === page) return;
  places[docId] = { page: Math.floor(page), at: Date.now() };
  store(KEY, places);
}

/**
 * Where in a text document the reader is: the line being read, as scene units
 * down from the top of the document, and how tall the document was laid out
 * when that was taken. A layout that has changed height since (another type
 * size, a wider column) puts the line at the same share of the way down.
 */
export interface ReadingPlace {
  y: number;
  height: number;
}

/** Moves smaller than this (scene units) are the same place: no write, no newer timestamp. */
const PLACE_SLOP = 2;

function isPlace(value: unknown): value is ReadingPlace {
  const place = value as Partial<ReadingPlace> | null;
  return Boolean(place) && Number.isFinite(place!.y) && place!.y! >= 0 &&
    Number.isFinite(place!.height) && place!.height! > 0;
}

/**
 * Which text document a place belongs to: its annotation set's id, and the
 * hash of its content. A note that is only read has no saved set, so the id
 * it opens under can be a new one each time (a file picked again from Files
 * mints one); the content hash is the same file whatever id it opens under.
 */
export interface ReadingPlaceKey {
  docId?: string | null;
  hash?: string | null;
}

function placeKeys(key: string | ReadingPlaceKey | null | undefined): { id: string | null; content: string | null } {
  if (typeof key === "string") return { id: key || null, content: null };
  return { id: key?.docId || null, content: key?.hash ? `#${key.hash}` : null };
}

/**
 * The place this text document was last read at here, or null. Only a
 * reading newer than `savedAt` counts, as for {@link loadReadingPage}.
 *
 * The set's own place first. Only a set with none (a new id) falls back to
 * the place this file's content was last read at, under whatever id: two
 * annotation sets of one file keep their own places.
 */
export function loadReadingPlace(key: string | ReadingPlaceKey | null | undefined, savedAt = 0): ReadingPlace | null {
  const { id, content } = placeKeys(key);
  const places = load<ReadingPlace & Entry>(PLACE_KEY);
  const own = id ? places[id] : undefined;
  const entry = isPlace(own) ? own : content ? places[content] : undefined;
  if (!isPlace(entry) || !(Number(entry.at) > savedAt)) return null;
  return { y: entry.y, height: entry.height };
}

export function saveReadingPlace(key: string | ReadingPlaceKey | null | undefined, place: ReadingPlace | null): void {
  const { id, content } = placeKeys(key);
  if (!id || !isPlace(place)) return;
  const places = load<ReadingPlace & Entry>(PLACE_KEY);
  const at = Date.now();
  let changed = false;
  for (const name of content ? [id, content] : [id]) {
    const prior = places[name];
    if (isPlace(prior) && Math.abs(prior.y - place.y) < PLACE_SLOP && Math.abs(prior.height - place.height) < PLACE_SLOP) {
      continue;
    }
    places[name] = { y: place.y, height: place.height, at };
    changed = true;
  }
  if (changed) store(PLACE_KEY, places);
}
