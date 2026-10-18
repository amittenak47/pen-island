import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { expect, vi } from "vitest";
import { LcApiError, type BookStateDto, type CommitRequestDto, type CommitResultDto, type InkPageDto, type LcClient, type PadSnapshotDto } from "../api/client";
import { bytesToB64, b64ToBytes } from "../api/nativeHttp";
import { encodeInkOps, packEncodedInk, unpackEncodedInk, type EncodedInk } from "../canvas/inkCodec";
import { captureBook } from "./bookSnapshot";
import { syncBook, type BookSyncOptions } from "./bookSync";
import { closeDbForTests } from "./idb";
import { putInkPages } from "./inkPageStore";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { resetLocalBookStoreForTests } from "./localBookStore";
import { recordHash, validateInk } from "./syncContent";
import { saveWhiteboardNotebook, trashWhiteboardNotebook } from "./whiteboardStore";
import { saveAnnotateDoc, trashAnnotateDoc } from "./annotateStore";
import { resetPadSyncForTests } from "./padSync";
import { savePadHub, setHostLoopback } from "./padHub";
import { beginPadHubStatusRequest, refreshPadHubStatus, reportPadHubStatus } from "./padHubStatus";

export type TimelineKind = "annotate" | "whiteboard";
export const timelineKinds = ["annotate", "whiteboard"] as const;
export const board = { v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
export const emptyInk = encodeInkOps([]);
export const drawing = (color = "#111111") => encodeInkOps([{ kind: "draw", color, baseWidth: 2, maxFullness: .8, pressureClip: .6, pressureSensitive: true,
  points: [{ x: 1, y: 2, pressure: .5 }, { x: 4, y: 5, pressure: .5 }] }]);
export const timelineOptions: BookSyncOptions = { wait: async () => {}, timeoutMs: 100 };
const HUB = { url: "http://timeline.test:7878", token: "timeline" };
const identity = (kind: string, id: string) => `${kind}:${id}`;
const pageIdentity = (kind: string, key: string, pageId: number) => JSON.stringify([kind, key, pageId]);

/** Copied from bookSync.test.ts, with the real hub's gone/restore CAS rules. */
export async function timelineHarness(kind: TimelineKind = "whiteboard", id = "book") {
  await closeDbForTests(); resetBookCoordinatorForTests(); resetLocalBookStoreForTests(); resetPadSyncForTests();
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const devices = new Map<string, { db: IDBFactory; values: Map<string, string> }>(), locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", { locks: { request: (key: string, option: (() => Promise<unknown>) | LockOptions, callback?: () => Promise<unknown>) => {
    const work = typeof option === "function" ? option : callback!, prior = locks.get(key) ?? Promise.resolve(), result = prior.catch(() => {}).then(work);
    locks.set(key, result); return result;
  } } });
  const status = (value: "online" | "offline") => reportPadHubStatus(beginPadHubStatusRequest(HUB), value);
  const switchDevice = async (name: string) => {
    await closeDbForTests(); resetBookCoordinatorForTests(); resetLocalBookStoreForTests(); resetPadSyncForTests();
    let device = devices.get(name);
    if (!device) { device = { db: new IDBFactory(), values: new Map() }; devices.set(name, device); }
    const { db, values } = device;
    vi.stubGlobal("indexedDB", db);
    vi.stubGlobal("localStorage", { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    setHostLoopback(null); savePadHub(HUB); refreshPadHubStatus(); status("online");
  };
  await switchDevice("this");
  let revision = 0;
  const books = new Map<string, BookStateDto>(), pages = new Map<string, InkPageDto>(), staged = new Map<string, InkPageDto>(), receipts = new Map<string, CommitResultDto>();
  const copies = new Map<string, PadSnapshotDto>();
  const get = (bookKind: TimelineKind = kind, bookId = id): BookStateDto => books.get(identity(bookKind, bookId)) ?? {
    kind: bookKind, id: bookId, book_rev: 0, state: "absent", gone_seq: null, record_rev: 0, record_hash: null, record: null, pages: [],
  };
  const set = (book: BookStateDto) => { books.set(identity(book.kind, book.id), book); return book; };
  const vector = (book: BookStateDto) => book.state === "gone" ? book.retained_restore_pages ?? [] : book.pages;
  const ownedPages = (book: BookStateDto) => [...pages.values()].filter(page => page.kind === book.kind && (page.key === book.id || page.key.startsWith(`${book.id}/fn/`)))
    .map(page => ({ key: page.key, page_id: page.page_id, rev: page.rev!, hash: page.hash! }));
  const otherDelete = (bookKind: TimelineKind = kind, bookId = id, seq = 9) => {
    const book = get(bookKind, bookId);
    return set({ ...book, state: "gone", record: null, record_hash: null, record_rev: 0, pages: [], retained_restore_pages: ownedPages(book), gone_seq: seq, book_rev: ++revision });
  };
  const api = {
    getBookState: vi.fn(async (bookKind: TimelineKind, bookId: string) => structuredClone(get(bookKind, bookId))),
    checkBookHead: vi.fn(async (bookKind: TimelineKind, bookId: string, head: number) => {
      if (head !== get(bookKind, bookId).book_rev) throw new LcApiError("head changed", 409);
      return { unchanged: true as const, book_rev: head };
    }),
    getInkPage: vi.fn(async (bookKind: TimelineKind, key: string, pageId: number, conditions?: { bookRev?: number; pageRev?: number }) => {
      const bookId = key.split("/fn/")[0]!, book = get(bookKind, bookId), row = pages.get(pageIdentity(bookKind, key, pageId));
      if (conditions?.bookRev !== book.book_rev || row?.rev !== conditions.pageRev) throw new LcApiError("head/page changed", 409);
      return structuredClone(row ?? null);
    }),
    stageInkPage: vi.fn(async (uploadId: string, bookKind: TimelineKind, key: string, pageId: number, gz: string) => {
      const hash = (await validateInk(b64ToBytes(gz))).wireHash;
      staged.set(`${uploadId}:${pageIdentity(bookKind, key, pageId)}`, { kind: bookKind, key, page_id: pageId, gz, updated_at: 5, hash });
      return { staged: true as const, hash };
    }),
    commitPad: vi.fn(async (body: CommitRequestDto): Promise<CommitResultDto> => {
      const receipt = receipts.get(body.upload_id); if (receipt) return structuredClone(receipt);
      let book = get(body.kind as TimelineKind, body.id);
      if (body.action === "upsert" && book.state === "gone") throw new LcApiError("gone", 410, "", { book });
      if (body.action !== "upsert" && (body.base_book_rev !== book.book_rev || body.action === "restore" && (book.state !== "gone" || body.gone_seq !== book.gone_seq || body.seq! <= book.gone_seq!))) {
        throw new LcApiError("lifecycle conflict", 409, "", { book });
      }
      if (body.action === "delete") {
        if (body.seq! < Number(book.gone_seq ?? book.record?.sync_seq ?? 0)) throw new LcApiError("old delete sequence", 409);
        book = otherDelete(body.kind as TimelineKind, body.id, body.seq!);
        const result: CommitResultDto = { status: "committed", upload_id: body.upload_id, record_rev: null, page_revs: [], book: structuredClone(book) };
        receipts.set(body.upload_id, result); return result;
      }
      if (body.record && body.record.base_rev !== book.record_rev || body.pages.some(page => page.base_rev !== (pages.get(pageIdentity(body.kind, page.key, page.page_id))?.rev ?? 0))) throw new LcApiError("stale item", 409);
      if (body.action === "restore" && vector(book).some(page => !body.pages.some(candidate => candidate.key === page.key && candidate.page_id === page.page_id))) throw new LcApiError("restore omitted retained page", 409);
      if (body.record) book = { ...book, state: "live", record: structuredClone(body.record.value), record_rev: ++revision, record_hash: await recordHash(body.record.value) };
      const pageRevisions = [];
      for (const page of body.pages) {
        const stored = staged.get(`${body.upload_id}:${pageIdentity(body.kind, page.key, page.page_id)}`);
        if (!stored || stored.hash !== page.hash) throw new LcApiError("missing staging", 422, "", { missing_pages: [page] });
        const row = { ...stored, rev: ++revision }; pages.set(pageIdentity(body.kind, page.key, page.page_id), row);
        pageRevisions.push({ key: page.key, page_id: page.page_id, hash: page.hash, rev: row.rev });
      }
      book = set({ ...book, book_rev: revision, gone_seq: null, retained_restore_pages: [], pages: ownedPages(book) });
      const result: CommitResultDto = { status: "committed", upload_id: body.upload_id, record_rev: body.record ? book.record_rev : null, page_revs: pageRevisions, book: structuredClone(book) };
      receipts.set(body.upload_id, result); return result;
    }),
    getPadCommit: vi.fn(async (uploadId: string) => structuredClone(receipts.get(uploadId) ?? null)),
    putSnapshotCopy: vi.fn(async (bookKind: TimelineKind, bookId: string, contentHash: string, body: PadSnapshotDto) => {
      const key = JSON.stringify([bookKind, bookId, contentHash]), prior = copies.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(body)) throw new LcApiError("immutable copy changed", 409);
      copies.set(key, structuredClone(body));
      return { content_hash: contentHash, tier: body.tier, written_at: body.written_at, name: (body.payload as { name?: string })?.name ?? "" };
    }),
    listSnapshotCopies: vi.fn(async (bookKind: TimelineKind, bookId: string) => [...copies].filter(([key]) => {
      const [candidateKind, candidateId] = JSON.parse(key); return candidateKind === bookKind && candidateId === bookId;
    }).map(([key, body]) => ({ content_hash: JSON.parse(key)[2], tier: body.tier, written_at: body.written_at, name: (body.payload as { name?: string })?.name ?? "" }))),
    getSnapshotCopy: vi.fn(async (bookKind: TimelineKind, bookId: string, contentHash: string) => structuredClone(copies.get(JSON.stringify([bookKind, bookId, contentHash])) ?? null)),
    pingPadSync: vi.fn(async () => ({ now: 5, features: ["atomic_book_sync_v1"], books: [...books.values()].map(book => structuredClone(book)), whiteboard: [], annotate: [], problem: [], snapshots: [], gone: [], ink: [], edges: [] })),
    docBytesOnHub: vi.fn(async () => false),
    putDocBytes: vi.fn(async () => {}),
    getDocBytes: vi.fn(async () => null),
    putInkPage: vi.fn(async () => { throw new Error("Modern choices cannot write live ink"); }),
  } as unknown as LcClient;
  const localKey = `${kind === "annotate" ? "md" : "wb"}:${id}`;
  const save = async (title = "Book") => kind === "whiteboard"
    ? saveWhiteboardNotebook({ id, title, metadataIntent: "rename", board, pageCount: 2, agent: [] })
    : saveAnnotateDoc({ id, name: title, metadataIntent: "rename", hash: "source", source: "text", board, docType: "markdown", footnotes: [], agent: [] });
  const capture = () => captureBook({ kind, id });
  const sync = (options: BookSyncOptions = {}) => syncBook(api, kind, id, undefined, { ...timelineOptions, ...options });
  const initial = async () => { await save(); await putInkPages(localKey, [[1, emptyInk], [2, emptyInk]]); expect((await sync()).status).toBe("synced"); };
  const trash = () => kind === "whiteboard" ? trashWhiteboardNotebook(id) : trashAnnotateDoc(id);
  const otherRecord = async (title: string) => {
    const book = get(), record = { ...book.record!, sync_seq: 8, ...(kind === "whiteboard" ? { title } : { name: title }) };
    return set({ ...book, state: "live", record, record_hash: await recordHash(record), record_rev: ++revision, book_rev: revision });
  };
  const otherPage = async (pageId: number, ink: EncodedInk) => {
    const gz = bytesToB64(packEncodedInk(ink)), hash = (await validateInk(b64ToBytes(gz))).wireHash;
    pages.set(pageIdentity(kind, id, pageId), { kind, key: id, page_id: pageId, gz, updated_at: 5, rev: ++revision, hash });
    const book = get(); return set({ ...book, book_rev: revision, pages: ownedPages(book) });
  };
  const hubInk = async (pageId: number, bookKind: TimelineKind = kind, bookId = id) => unpackEncodedInk((await validateInk(b64ToBytes(pages.get(pageIdentity(bookKind, bookId, pageId))!.gz!))).packed);
  const sweepHub = () => {
    const book = get();
    for (const [key, page] of pages) if (page.kind === kind && (page.key === id || page.key.startsWith(`${id}/fn/`))) pages.delete(key);
    set({ ...book, retained_restore_pages: [], book_rev: ++revision });
  };
  const clearCalls = () => { for (const value of Object.values(api)) if (vi.isMockFunction(value)) value.mockClear(); };
  return { api, kind, id, localKey, get, capture, save, sync, initial, trash, status, otherRecord, otherPage, otherDelete, hubInk, clearCalls, switchDevice, sweepHub };
}

export async function closeTimelineHarness() {
  await closeDbForTests(); resetBookCoordinatorForTests(); resetLocalBookStoreForTests(); resetPadSyncForTests();
  savePadHub(null); refreshPadHubStatus(); vi.restoreAllMocks(); vi.unstubAllGlobals();
}
