import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LcApiError, type BookStateDto, type CommitRequestDto, type CommitResultDto, type InkPageDto, type LcClient } from "../api/client";
import { b64ToBytes, bytesToB64 } from "../api/nativeHttp";
import { decodeInkOps, encodeInkOps, packEncodedInk, unpackEncodedInk, type PdfInkLayout } from "../canvas/inkCodec";
import type { InkOp } from "../canvas/rasterInk";
import { savePdfPageSizes } from "../modes/pdfPageSizeCache";
import { saveAnnotateDoc } from "./annotateStore";
import { askBookConflict } from "./bookConflictUi";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { captureBook } from "./bookSnapshot";
import { syncBook, type BookSyncOptions } from "./bookSync";
import { putDocBytes } from "./docBytes";
import { bytesFromMaybeGzip } from "./gzip";
import { HubSyncCancelled } from "./hubConflictStash";
import { closeDbForTests } from "./idb";
import { encodedFromRecord, getInkPageRecord, putInkPages } from "./inkPageStore";
import { localizePendingPdfInk } from "./inkSync";
import { resetLocalBookStoreForTests } from "./localBookStore";
import { recordHash, validateInk } from "./syncContent";
import { getBookSyncState, syncStateNeedsWork } from "./syncState";
import { conflictPdfFrames } from "../components/conflictDocumentLayout";
import { locatePdfInkPoint } from "../modes/pdfInkSpread";
import { desktopLayout, pdfBoard, pdfPoint, pdfSizes, pdfStroke, tabletLayout } from "./testPdfInk";

const owner = { kind: "annotate" as const, id: "device-layout-pdf" };
const hash = "device-layout-source", pageId = 45;
let docKey: string, deviceRun = 0;
const options = { timeoutMs: 3000, wait: async () => {} };
const device = () => ({ db: new IDBFactory(), values: new Map<string, string>() });
let tablet: ReturnType<typeof device>, desktop: ReturnType<typeof device>;
let head: BookStateDto, api: LcClient, revision: number;
let pages: Map<number, InkPageDto>, staged: Map<string, InkPageDto>;

async function useDevice(target: ReturnType<typeof device>) {
  await closeDbForTests(); resetBookCoordinatorForTests(); resetLocalBookStoreForTests();
  vi.stubGlobal("indexedDB", target.db); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const values = target.values;
  vi.stubGlobal("localStorage", { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
}
async function savePdf(layout: PdfInkLayout, geometry = true) {
  if (geometry) savePdfPageSizes(hash, pdfSizes);
  await putDocBytes(hash, new Uint8Array([1, 2, 3]).buffer);
  await saveAnnotateDoc({ id: owner.id, name: "Device layouts.pdf", hash, docType: "pdf", source: "",
    board: pdfBoard(layout), footnotes: [], agent: [] });
}
const sync = (extra: BookSyncOptions = {}) => syncBook(api, owner.kind, owner.id, undefined, { ...options, ...extra });
async function readPage() { return (await encodedFromRecord((await getInkPageRecord(docKey, pageId))!))!; }
async function decodeDto(dto: InkPageDto) { return unpackEncodedInk(await bytesFromMaybeGzip(b64ToBytes(dto.gz)))!; }
function expectMarks(ops: readonly InkOp[], layout: PdfInkLayout, ids: readonly number[]) {
  expect(ops.map(op => op.id)).toEqual(ids);
  expect(new Set(ops.map(op => op.id)).size).toBe(ops.length);
  ops.forEach(op => op.points.forEach((point, i) => {
    const expected = pdfStroke(pdfSizes, layout, pageId, op.id === 102 || op.id === 201 ? "right" : "left", op.id).points[i];
    expect(point.x).toBeCloseTo(expected.x, 1);
    expect(point.y).toBeCloseTo(expected.y, 1);
  }));
}
function expectSpanningSheets(ops: readonly InkOp[]) {
  expect(ops).toHaveLength(2);
  expect(ops.map(op => op.points.length)).toEqual([1, 1]);
  const frames = conflictPdfFrames(pdfSizes, desktopLayout.w, desktopLayout.spread);
  expect(ops.flatMap(op => op.points).map(point =>
    locatePdfInkPoint(point.x, point.y, frames, 0, desktopLayout.w)?.pageId)).toEqual([45, 46]);
}
async function seedTablet(ids = [101, 102]) {
  await useDevice(tablet); await savePdf(tabletLayout);
  await putInkPages(docKey, [[pageId, encodeInkOps(ids.map(id => pdfStroke(pdfSizes, tabletLayout, pageId, id === 102 ? "right" : "left", id)))]]);
  expect((await sync()).status).toBe("synced");
}
async function pullDesktop(geometry = true) {
  await useDevice(desktop); await savePdf(desktopLayout, geometry);
  // These independently created records have different frame dimensions.
  // Accept the shared record while preserving this device's reading layout.
  expect((await sync({ manual: true, requestChoice: async (conflict, lifecycle) => {
    lifecycle.onMounted(); expect(conflict.pages).toEqual([]);
    return { record: "server", pages: [] };
  } })).status).toBe(head.pages.length ? "synced" : "unchanged");
}

async function legacySpanningConflict(tagged = false) {
  const spanning = (layout: PdfInkLayout) => ({ ...pdfStroke(pdfSizes, layout, 45, "left", 401), points: [
    pdfPoint(pdfSizes, layout, 45, "left", .3, .8), pdfPoint(pdfSizes, layout, 46, "left", .3, .2),
  ] });
  await seedTablet([101]);
  await putInkPages(docKey, [[0, encodeInkOps([spanning(tabletLayout)])]]);
  expect((await sync()).status).toBe("synced");
  await pullDesktop();
  await putInkPages(docKey, [[pageId, encodeInkOps([...decodeInkOps(await readPage()), pdfStroke(pdfSizes, desktopLayout, 45, "right", 201)])],
    [0, encodeInkOps([spanning(desktopLayout)])]]);
  await useDevice(tablet);
  await putInkPages(docKey, [[pageId, encodeInkOps([pdfStroke(pdfSizes, tabletLayout, 45, "left", 101),
    { ...pdfStroke(pdfSizes, tabletLayout, 45, "left", 301), color: "#123456" }])]]);
  expect((await sync()).status).toBe("synced");
  const sheet = await decodeDto(pages.get(pageId)!); delete sheet.layout;
  const span = { ...encodeInkOps([spanning(tabletLayout)]), ...(tagged ? { layout: tabletLayout } : {}) };
  for (const [id, encoded] of [[0, span], [pageId, sheet]] as const) {
    const packed = packEncodedInk(encoded), wire = await validateInk(packed);
    pages.set(id, { kind: owner.kind, key: owner.id, page_id: id, rev: ++revision, hash: wire.wireHash, updated_at: 456, gz: bytesToB64(packed) });
  }
  head = { ...head, book_rev: revision, pages: [pages.get(0)!, pages.get(pageId)!].map(row => ({ key: row.key, page_id: row.page_id, rev: row.rev!, hash: row.hash! })) };
  await useDevice(desktop);
  vi.mocked(api.getInkPage).mockClear();
}

beforeEach(async () => {
  owner.id = `device-layout-pdf-${++deviceRun}`; docKey = `md:${owner.id}`;
  tablet = device(); desktop = device(); pages = new Map(); staged = new Map(); revision = 0;
  vi.stubGlobal("navigator", { locks: { request: (_key: string, option: unknown, callback?: () => Promise<unknown>) => typeof option === "function" ? option() : callback!() } });
  head = { ...owner, state: "absent", book_rev: 0, record_rev: 0, record_hash: null, record: null, pages: [], gone_seq: null };
  api = {
    getBookState: vi.fn(async () => structuredClone(head)),
    checkBookHead: vi.fn(async (_kind, _id, rev) => {
      if (rev !== head.book_rev) throw new LcApiError("head changed", 409);
      return { unchanged: true, book_rev: rev };
    }),
    docBytesOnHub: vi.fn(async () => true),
    getInkPage: vi.fn(async (_kind, key, id, conditions) => {
      const row = pages.get(id);
      if (key !== owner.id || conditions?.bookRev !== head.book_rev || conditions.pageRev !== row?.rev) throw new LcApiError("page changed", 409);
      return structuredClone(row ?? null);
    }),
    stageInkPage: vi.fn(async (uploadId, kind, key, id, gz) => {
      const hash = (await validateInk(b64ToBytes(gz))).wireHash;
      staged.set(`${uploadId}:${id}`, { kind, key, page_id: id, gz, hash, updated_at: 123 });
      return { staged: true, hash };
    }),
    commitPad: vi.fn(async (body: CommitRequestDto) => {
      if (body.record && body.record.base_rev !== head.record_rev || body.pages.some(page => page.base_rev !== (pages.get(page.page_id)?.rev ?? 0))) throw new LcApiError("stale item", 409);
      const incoming = body.pages.map(page => {
        const row = staged.get(`${body.upload_id}:${page.page_id}`);
        if (!row || row.hash !== page.hash) throw new Error("Missing staged page");
        return row;
      });
      if (body.record) head = { ...head, state: "live", record: structuredClone(body.record.value), record_rev: ++revision, record_hash: await recordHash(body.record.value) };
      const pageRevs = incoming.map(row => {
        const saved = { ...row, rev: ++revision }; pages.set(row.page_id, saved);
        return { key: row.key, page_id: row.page_id, hash: row.hash!, rev: saved.rev };
      });
      head = { ...head, book_rev: revision, pages: [...pages.values()].map(row => ({ key: row.key, page_id: row.page_id, hash: row.hash!, rev: row.rev! })) };
      return { status: "committed", upload_id: body.upload_id, record_rev: body.record ? head.record_rev : null, page_revs: pageRevs, book: structuredClone(head) } as CommitResultDto;
    }),
    putInkPage: vi.fn(async () => { throw new Error("Atomic sync must stage and commit"); }),
  } as unknown as LcClient;
});
afterEach(async () => { await closeDbForTests(); resetLocalBookStoreForTests(); vi.unstubAllGlobals(); });

describe("PDF ink through atomic two-device sync", () => {
  it.each([null, 642])("localizes an untagged spanning shard listed before its sheet using hub width %s", async hint => {
    await useDevice(tablet); await savePdf(tabletLayout);
    expect((await sync()).status).toBe("synced");
    await pullDesktop();
    const sheet = encodeInkOps([pdfStroke(pdfSizes, tabletLayout, pageId, "left", 101)]);
    const spanning = { ...pdfStroke(pdfSizes, tabletLayout, pageId), points: [
      pdfPoint(pdfSizes, tabletLayout, 45, "left", .3, .8), pdfPoint(pdfSizes, tabletLayout, 46, "left", .3, .2),
    ] };
    for (const [id, encoded] of [[0, encodeInkOps([spanning])], [pageId, sheet]] as const) {
      const packed = packEncodedInk(encoded), wire = await validateInk(packed);
      pages.set(id, { kind: owner.kind, key: owner.id, page_id: id, rev: ++revision, hash: wire.wireHash, updated_at: 456, gz: bytesToB64(packed) });
    }
    const record = structuredClone(head.record!);
    const state = (record.board as { appState: { pdfWidth?: number } }).appState;
    if (hint == null) delete state.pdfWidth; else state.pdfWidth = hint;
    head = { ...head, record, record_hash: await recordHash(record), record_rev: ++revision, book_rev: revision,
      pages: [pages.get(0)!, pages.get(pageId)!].map(row => ({ key: row.key, page_id: row.page_id, rev: row.rev!, hash: row.hash! })) };
    expect((await sync()).status).toBe("synced");
    const ink = (await encodedFromRecord((await getInkPageRecord(docKey, 0))!))!;
    const ops = decodeInkOps(ink);
    expectSpanningSheets(ops);
    if (hint) ops.forEach((op, i) => {
      const expected = pdfPoint(pdfSizes, desktopLayout, 45 + i, "left", .3, i ? .2 : .8);
      expect(op.points[0].x).toBeCloseTo(expected.x, 1);
      expect(op.points[0].y).toBeCloseTo(expected.y, 1);
    });
    expect(ink.layout).toEqual(desktopLayout);
  });

  it("marks a pull without geometry, converts once on open, and keeps the destination tag", async () => {
    await seedTablet(); await pullDesktop(false);
    const pending = (await getInkPageRecord(docKey, pageId))!;
    expect(pending.layoutPending).toBe(true);
    expect((await readPage()).layout).toEqual(tabletLayout);
    expect(await localizePendingPdfInk(owner.id)).toBe(0);
    expect(await getInkPageRecord(docKey, pageId)).toEqual(pending);
    savePdfPageSizes(hash, pdfSizes);
    expect(await localizePendingPdfInk(owner.id)).toBe(1);
    const converted = (await getInkPageRecord(docKey, pageId))!;
    expect(converted.layoutPending).toBeUndefined();
    expect((await readPage()).layout).toEqual(desktopLayout);
    expectMarks(decodeInkOps(await readPage()), desktopLayout, [101, 102]);
    expect(await localizePendingPdfInk(owner.id)).toBe(0);
    expect(await getInkPageRecord(docKey, pageId)).toEqual(converted);
    await useDevice(desktop); // Reopening the same durable database still does nothing.
    expect(await localizePendingPdfInk(owner.id)).toBe(0);
    expect(await getInkPageRecord(docKey, pageId)).toEqual(converted);
  });

  it.each([false, true])("deduplicates concurrent previews and loads siblings only for untagged spanning ink (tagged: %s)", async tagged => {
    await legacySpanningConflict(tagged);
    let previewOps: InkOp[] = [];
    let previewRequests: number[] = [];
    const result = await sync({ manual: true, requestChoice: (conflict, lifecycle) => askBookConflict(conflict, lifecycle, async (pad, ui) => {
      ui.onMounted();
      const [preview, duplicate] = await Promise.all([
        pad.fetchPreviewInk!(0), pad.fetchPreviewInk!(0),
        ...(tagged ? [] : [pad.fetchPreviewInk!(pageId)]),
      ]);
      expect(duplicate).toEqual(preview);
      previewRequests = vi.mocked(api.getInkPage).mock.calls.map(call => call[2]).sort((a, b) => a - b);
      previewOps = decodeInkOps(await decodeDto(preview.server as InkPageDto));
      return { pick: "server", ink: "server" };
    }) });
    expect(previewRequests).toEqual(tagged ? [0] : [0, pageId]);
    expect(result.error).toBeUndefined();
    expectSpanningSheets(previewOps);
    previewOps.forEach((op, i) => {
      const expected = pdfPoint(pdfSizes, desktopLayout, 45 + i, "left", .3, i ? .2 : .8);
      expect(op.points[0].x).toBeCloseTo(expected.x, 1);
      expect(op.points[0].y).toBeCloseTo(expected.y, 1);
    });
    expect(result.status).toBe("unchanged");
    expect(decodeInkOps((await encodedFromRecord((await getInkPageRecord(docKey, 0))!))!)).toEqual(previewOps);
    expect(vi.mocked(api.getInkPage).mock.calls.map(call => call[2]).sort((a, b) => a - b)).toEqual([0, pageId]);
  });

  it.each(["abort", "close"])("stops pending spanning previews after %s without downloading siblings or publishing", async action => {
    await legacySpanningConflict();
    const before = await captureBook(owner);
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const get = vi.mocked(api.getInkPage).getMockImplementation()!;
    let fetched: Promise<InkPageDto | null> | undefined;
    vi.mocked(api.getInkPage).mockImplementation((...args) => fetched = (async () => {
      await gate; return get(...args);
    })());
    let pending: Promise<unknown> | undefined;
    try {
      const result = await sync({ manual: true, signal: controller.signal, requestChoice: async (conflict, lifecycle) => {
        lifecycle.onMounted();
        pending = conflict.loadPage(conflict.pages.find(page => page.page_id === 0)!).catch(cause => cause);
        if (action === "abort") controller.abort();
        throw new HubSyncCancelled();
      } });
      expect(result.status).toBe("cancelled");
      expect(pending).toBeDefined();
      expect(await pending).toBeInstanceOf(HubSyncCancelled);
      expect(await captureBook(owner)).toEqual(before);
    } finally {
      release(); await fetched;
    }
    expect(vi.mocked(api.getInkPage).mock.calls.map(call => call[2])).toEqual([0]);
  });

  it.each([true, false])("keeps a layout-only pull clean with geometry available: %s", async geometry => {
    await seedTablet(); await pullDesktop(geometry);
    const before = (await getInkPageRecord(docKey, pageId))!;
    const state = await getBookSyncState(owner.kind, owner.id);
    if (!geometry) {
      savePdfPageSizes(hash, pdfSizes);
      expect(await localizePendingPdfInk(owner.id)).toBe(1);
    }
    const row = (await getInkPageRecord(docKey, pageId))!;
    for (const field of ["updatedAt", "syncedUpdatedAt", "changeSeq", "syncedChangeSeq", "syncedRev", "baseWireHash"] as const) expect(row[field]).toEqual(before[field]);
    expect(row.dirty).toBe(false);
    expect(row.baseLocalHash).toBe((await validateInk(packEncodedInk(await readPage()))).wireHash);
    expect(row.baseWireHash).toBe(pages.get(pageId)!.hash);
    expect(await getBookSyncState(owner.kind, owner.id)).toEqual(state);
    expect(syncStateNeedsWork(state!)).toBe(false);
    vi.mocked(api.stageInkPage).mockClear(); vi.mocked(api.commitPad).mockClear();
    for (let repeat = 0; repeat < 2; repeat++) expect((await sync()).status).toBe("unchanged");
    expect(api.stageInkPage).not.toHaveBeenCalled(); expect(api.commitPad).not.toHaveBeenCalled();
    expect(api.putInkPage).not.toHaveBeenCalled();
    expect(syncStateNeedsWork((await getBookSyncState(owner.kind, owner.id))!)).toBe(false);
  });

  it.each([false, true])("keeps tablet erasures after desktop conversion and repeated sync (empty page: %s)", async empty => {
    await seedTablet(); await pullDesktop();
    await useDevice(tablet);
    await putInkPages(docKey, [[pageId, encodeInkOps(empty ? [] : [pdfStroke(pdfSizes, tabletLayout, pageId, "right", 102)])]]);
    expect((await sync()).status).toBe("synced");
    await useDevice(desktop);
    expect((await sync()).status).toBe("synced");
    expectMarks(decodeInkOps(await readPage()), desktopLayout, empty ? [] : [102]);
    expect((await readPage()).layout).toEqual(desktopLayout);
    for (const target of [tablet, desktop, tablet, desktop]) {
      await useDevice(target);
      expect((await sync()).status).toBe("unchanged");
      expectMarks(decodeInkOps(await readPage()), target === tablet ? tabletLayout : desktopLayout, empty ? [] : [102]);
    }
  });

  it.each(["local", "server", "merged", "none"] as const)("previews both edits in desktop coordinates and stores the %s choice with its layout tag", async choice => {
    await seedTablet([101]); await pullDesktop();
    const common = decodeInkOps(await readPage());
    await putInkPages(docKey, [[pageId, encodeInkOps([...common, pdfStroke(pdfSizes, desktopLayout, pageId, "right", 201)])]]);
    await useDevice(tablet);
    const added = { ...pdfStroke(pdfSizes, tabletLayout, pageId, "left", 301), color: "#123456" };
    await putInkPages(docKey, [[pageId, encodeInkOps([pdfStroke(pdfSizes, tabletLayout, pageId, "left", 101), added])]]);
    expect((await sync()).status).toBe("synced");
    await useDevice(desktop);
    const before = await captureBook(owner), hubBefore = structuredClone(head);
    const show = vi.fn(async (conflict: Parameters<Parameters<typeof askBookConflict>[2]>[0], lifecycle: Parameters<Parameters<typeof askBookConflict>[2]>[1]) => {
      lifecycle.onMounted();
      const preview = await conflict.fetchPreviewInk!(pageId);
      const local = preview.local as InkPageDto, server = preview.server as InkPageDto;
      expectMarks(decodeInkOps(await decodeDto(local)), desktopLayout, [101, 201]);
      const serverInk = await decodeDto(server);
      expect(serverInk.layout).toEqual(desktopLayout);
      expectMarks(decodeInkOps(serverInk), desktopLayout, [101, 301]);
      expect(await captureBook(owner)).toEqual(before);
      expect(head).toEqual(hubBefore);
      return { pick: choice === "none" ? "merged" as const : choice, ink: choice };
    });
    const result = await sync({ manual: true, requestChoice: (conflict, lifecycle) => askBookConflict(conflict, lifecycle, show) });
    expect(result.status).toBe(choice === "server" ? "unchanged" : "synced"); expect(show).toHaveBeenCalledOnce();
    const ids = choice === "local" ? [101, 201] : choice === "server" ? [101, 301] : choice === "none" ? [] : [101, 201, 301];
    expect((await readPage()).layout).toEqual(desktopLayout);
    expectMarks(decodeInkOps(await readPage()), desktopLayout, ids);
    if (choice === "local") {
      const saved = (await getInkPageRecord(docKey, pageId))!;
      expect(saved.inkC).toBeUndefined();
      expect(saved.gz).toEqual(b64ToBytes(pages.get(pageId)!.gz));
    }
    expect((await sync()).status).toBe("unchanged");
    await useDevice(tablet);
    expect((await sync()).status).toBe(choice === "server" ? "unchanged" : "synced");
    expectMarks(decodeInkOps(await readPage()), tabletLayout, ids);
    expect(api.putInkPage).not.toHaveBeenCalled();
  });
});
