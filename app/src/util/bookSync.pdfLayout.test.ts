import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BookStateDto, CommitRequestDto, CommitResultDto, LcClient } from "../api/client";
import { bytesToB64 } from "../api/nativeHttp";
import { decodeInkOps, encodeInkOps, packEncodedInk } from "../canvas/inkCodec";
import { conflictPdfFrames } from "../components/conflictDocumentLayout";
import { savePdfPageSizes } from "../modes/pdfPageSizeCache";
import { saveAnnotateDoc, getAnnotateDoc } from "./annotateStore";
import { captureBook, preserveRecordView } from "./bookSnapshot";
import { syncBook } from "./bookSync";
import { putDocBytes } from "./docBytes";
import { closeDbForTests } from "./idb";
import { getInkPageRecord, encodedFromRecord } from "./inkPageStore";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { resetLocalBookStoreForTests } from "./localBookStore";
import { pdfInkContextFromRecord } from "./pdfInkLayout";
import { recordHash, validateInk } from "./syncContent";

const owner = { kind: "annotate" as const, id: "pdf-layout-book" };
const sizes = Array.from({ length: 60 }, (_, i) => ({ pageNumber: i + 1, width: 600, height: 800 }));
const frame = (width: number, height: number) => ({ id: "lcmdink-0-frame", width, height, customData: { lcMdInkFrame: true } });
const board = (width: number, height: number) => ({ v: 1 as const, elements: [frame(width, height)], appState: { scrollX: 0, scrollY: 0, zoom: 1 } });

beforeEach(async () => {
  await closeDbForTests(); resetBookCoordinatorForTests(); resetLocalBookStoreForTests();
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal("navigator", { locks: { request: (_key: string, options: unknown, fn?: () => Promise<unknown>) => typeof options === "function" ? options() : fn!() } });
});
afterEach(async () => { await closeDbForTests(); resetLocalBookStoreForTests(); vi.unstubAllGlobals(); });

it("keeps the tablet PDF column with localized page 50 through a remote record update and a clean second sync", async () => {
  const hash = "pdf-layout-source";
  savePdfPageSizes(hash, sizes);
  await putDocBytes(hash, new Uint8Array([1, 2, 3]).buffer);
  await saveAnnotateDoc({ id: owner.id, name: "Scratch.pdf", hash, docType: "pdf", source: "", board: board(642, 52667), footnotes: [], agent: [] });
  let head: BookStateDto = { ...owner, state: "absent", book_rev: 0, record_rev: 0, record_hash: null, record: null, pages: [], gone_seq: null };
  const api = {
    getBookState: vi.fn(async () => structuredClone(head)),
    checkBookHead: vi.fn(async () => ({ unchanged: true, book_rev: head.book_rev })),
    docBytesOnHub: vi.fn(async () => true),
    commitPad: vi.fn(async (body: CommitRequestDto) => {
      const record = body.record!.value;
      head = { ...head, state: "live", record, record_hash: await recordHash(record), record_rev: head.record_rev + 1, book_rev: head.book_rev + 1 };
      return { status: "committed", upload_id: body.upload_id, record_rev: head.record_rev, page_revs: [], book: structuredClone(head) } as CommitResultDto;
    }),
    getInkPage: vi.fn(),
    stageInkPage: vi.fn(async () => { throw new Error("A download must not upload pages"); }),
  } as unknown as LcClient;
  const options = { timeoutMs: 1000, wait: async () => {} };
  expect((await syncBook(api, owner.kind, owner.id, undefined, options)).status).toBe("synced");

  const desktopFrame = conflictPdfFrames(sizes, 760, false).find(page => page.pageId === 50)!;
  const relativeY = 134 / 800;
  const encoded = { ...encodeInkOps([{ kind: "draw", color: "#123456", baseWidth: 2, maxFullness: 1, pressureClip: 1, pressureSensitive: false,
    points: [{ x: 760 * 40 / 600, y: desktopFrame.minY + (desktopFrame.maxY - desktopFrame.minY) * relativeY, pressure: .5 },
      { x: 760 * 200 / 600, y: desktopFrame.minY + (desktopFrame.maxY - desktopFrame.minY) * relativeY, pressure: .5 }] }]), layout: { w: 760, spread: false } };
  const packed = packEncodedInk(encoded), wire = await validateInk(packed);
  const remoteRecord = { ...head.record!, name: "Renamed.pdf", board: board(760, 62088) };
  const page = { key: owner.id, page_id: 50, rev: 3, hash: wire.wireHash };
  head = { ...head, book_rev: 3, record_rev: 2, record: remoteRecord, record_hash: await recordHash(remoteRecord), pages: [page] };
  vi.mocked(api.getInkPage).mockResolvedValue({ ...owner, key: owner.id, page_id: 50, rev: 3, hash: wire.wireHash, updated_at: 1, gz: bytesToB64(packed) });
  vi.mocked(api.commitPad).mockClear();
  expect((await syncBook(api, owner.kind, owner.id, undefined, options)).status).toBe("synced");

  const doc = (await getAnnotateDoc(owner.id))!;
  expect(doc.name).toBe("Renamed.pdf");
  expect(doc.board.elements[0]).toMatchObject({ width: 642, height: 52667 });
  expect(pdfInkContextFromRecord((await captureBook(owner)).record)!.layout).toEqual({ w: 642, spread: false });
  const ink = (await encodedFromRecord((await getInkPageRecord(`md:${owner.id}`, 50))!))!;
  expect(ink.layout).toEqual({ w: 642, spread: false });
  const tabletFrame = conflictPdfFrames(sizes, 642, false).find(row => row.pageId === 50)!;
  const point = decodeInkOps(ink)[0].points[0];
  expect((point.y - tabletFrame.minY) / (tabletFrame.maxY - tabletFrame.minY)).toBeCloseTo(relativeY, 3);
  expect(point.x / 642).toBeCloseTo(40 / 600, 3);
  expect((await syncBook(api, owner.kind, owner.id, undefined, options)).status).toBe("unchanged");
  expect(api.commitPad).not.toHaveBeenCalled(); expect(api.stageInkPage).not.toHaveBeenCalled();
});

it.each(["pdf", "markdown"])("uses the incoming frame when the source changes (%s)", docType => {
  const local = { doc_type: docType, hash: "old-source", board: board(642, 52667) };
  const remote = { doc_type: docType, hash: "new-source", board: board(760, 62088) };
  expect((preserveRecordView(remote, local).board as ReturnType<typeof board>).elements[0]).toMatchObject({ width: 760, height: 62088 });
  expect(local.board.elements[0].width).toBe(642);
});
