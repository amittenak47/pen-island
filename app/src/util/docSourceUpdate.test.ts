/** @vitest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDbForTests, run, STORE_CONTENT } from "./idb";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { resetLocalBookStoreForTests } from "./localBookStore";
import { docIdentityHash, getAnnotateDoc, hashMarkdown, saveAnnotateDoc } from "./annotateStore";
import { clearDocSource, getDocSource, setDocSource, type DocSourceRef } from "./docSourceStore";
import { checkDocSource, justLinkDocSource, linkDocSource, unlinkDocSource, updateDocFromSource, DOC_SOURCE_UPDATING_EVENT } from "./docSourceUpdate";
import { captureBook } from "./bookSnapshot";
import { clearDocBytes, deleteDocBytes, getDocBytes, hashBytes, putDocBytes } from "./docBytes";
import { encodeInkOps } from "../canvas/inkCodec";
import { getInkPageRecords, putInkPages } from "./inkPageStore";
import * as recovery from "./syncRecovery";
import * as native from "./docSourceNative";
import { putArtifactAsset } from "./artifactAssetStore";
import type { ArtifactCatalog } from "./padArtifacts";

vi.mock("./docSourceNative", () => ({ statDocumentSource: vi.fn(), readDocumentSource: vi.fn() }));
vi.mock("../modes/PdfDocument", () => ({
  loadPdfJs: async () => ({ getDocument: () => ({ promise: Promise.resolve({ numPages: 1 }), destroy: async () => {} }) }),
  pdfJsDataUrls: () => ({}), pdfWorker: () => undefined,
}));
const board = { v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
const bytes = (text: string): ArrayBuffer => structuredClone(Uint8Array.from(text, c => c.charCodeAt(0)).buffer);
const source = (hash: string): DocSourceRef => ({ kind: "path", location: "C:/private/book", name: "book", size: 3, modified: 1, hash, checkedAt: 1 });
async function textBook(text = "old words") {
  const hash = docIdentityHash({ docType: "code", name: "notes.txt", text });
  await saveAnnotateDoc({ id: "book", name: "notes.txt", docType: "code", hash, source: text, board, footnotes: [], agent: [] });
  setDocSource("book", source(hash));
  return hash;
}

beforeEach(async () => {
  await closeDbForTests(); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("ArrayBuffer", structuredClone(new ArrayBuffer(0)).constructor);
  localStorage.clear(); resetBookCoordinatorForTests(); resetLocalBookStoreForTests(); vi.clearAllMocks();
});
afterEach(async () => { await closeDbForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("checking a document source", () => {
  it("does nothing without a device reference", async () => {
    expect(await checkDocSource("book")).toEqual({ status: "none" }); expect(native.statDocumentSource).not.toHaveBeenCalled();
  });
  it("keeps missing references and the app copy", async () => {
    await textBook(); vi.mocked(native.statDocumentSource).mockResolvedValue(null);
    expect(await checkDocSource("book")).toMatchObject({ status: "missing" });
    expect(getDocSource("book")).not.toBeNull(); expect((await getAnnotateDoc("book"))?.source).toBe("old words");
  });
  it("uses equal size and modified metadata without reading", async () => {
    await textBook(); vi.mocked(native.statDocumentSource).mockResolvedValue({ size: 3, modified: 1 });
    expect(await checkDocSource("book")).toMatchObject({ status: "same" }); expect(native.readDocumentSource).not.toHaveBeenCalled();
  });
  it("reads an Android document even when its provider reports the old size and date", async () => {
    // The Downloads provider kept a file's old size and date after it was rewritten in place.
    await textBook(); setDocSource("book", { ...getDocSource("book")!, kind: "uri", location: "content://downloads/document/1" });
    vi.mocked(native.statDocumentSource).mockResolvedValue({ size: 3, modified: 1 });
    vi.mocked(native.readDocumentSource).mockResolvedValue(bytes("rewritten words"));
    expect(await checkDocSource("book")).toMatchObject({ status: "newer", text: "rewritten words" });
    expect(native.readDocumentSource).toHaveBeenCalledOnce();
  });
  it("compares the bytes with the set's current hash and refreshes metadata", async () => {
    const hash = await textBook(); setDocSource("book", { ...source("stale ref hash") });
    vi.mocked(native.statDocumentSource).mockResolvedValue({ size: 9, modified: 2 });
    vi.mocked(native.readDocumentSource).mockResolvedValue(bytes("old words"));
    expect(await checkDocSource("book")).toMatchObject({ status: "same", ref: { hash, size: 9, modified: 2 } });
    expect(getDocSource("book")).toMatchObject({ hash, size: 9, modified: 2, checkedAt: expect.any(Number) });
  });
  it("returns changed text and metadata without accepting the version", async () => {
    const old = await textBook();
    vi.mocked(native.statDocumentSource).mockResolvedValue({ size: 8, modified: 3 });
    vi.mocked(native.readDocumentSource).mockResolvedValue(bytes("new text"));
    expect(await checkDocSource("book")).toMatchObject({ status: "newer", text: "new text", ref: { size: 8, modified: 3 } });
    expect(getDocSource("book")?.hash).toBe(old);
  });
  it("does not replace a source associated while a check was in flight", async () => {
    const hash = await textBook();
    vi.mocked(native.statDocumentSource).mockResolvedValue({ size: 9, modified: 2 });
    vi.mocked(native.readDocumentSource).mockImplementation(async () => {
      setDocSource("book", { ...source(hash), location: "C:/new-source" });
      return bytes("old words");
    });
    await expect(checkDocSource("book")).rejects.toThrow("source changed");
    expect(getDocSource("book")?.location).toBe("C:/new-source");
  });
});

describe("linking a document source", () => {
  const pick = { kind: "path" as const, location: "C:/moved/notes.txt", name: "notes.txt", size: 9, modified: 2 };
  it("links the same content without changing the app copy", async () => {
    const hash = await textBook(); clearDocSource("book");
    vi.mocked(native.readDocumentSource).mockResolvedValue(bytes("old words"));
    expect(await linkDocSource("book", pick)).toEqual({ status: "linked" });
    expect(getDocSource("book")).toMatchObject({ ...pick, hash });
    expect((await getAnnotateDoc("book"))?.source).toBe("old words");
  });
  it("leaves the current source untouched until a different file is accepted", async () => {
    await textBook(); const before = getDocSource("book");
    vi.mocked(native.readDocumentSource).mockResolvedValue(bytes("new words"));
    expect(await linkDocSource("book", pick)).toMatchObject({ status: "differs", content: {
      status: "newer", text: "new words", ref: { ...pick, hash: hashMarkdown("new words") },
    } });
    expect(getDocSource("book")).toEqual(before);
  });
  it("just links using the current app hash and checks the different content next time", async () => {
    await textBook();
    vi.mocked(native.readDocumentSource).mockResolvedValue(bytes("new words"));
    const result = await linkDocSource("book", pick);
    if (result.status !== "differs") throw new Error("expected different content");
    const hash = hashMarkdown("edited in the app");
    await saveAnnotateDoc({ id: "book", name: "notes.txt", docType: "code", hash, source: "edited in the app", board });
    justLinkDocSource("book", result.content.ref);
    expect(getDocSource("book")).toMatchObject({ ...pick, hash, checkedAt: 0 });
    vi.mocked(native.statDocumentSource).mockResolvedValue({ size: pick.size, modified: pick.modified });
    expect(await checkDocSource("book")).toMatchObject({ status: "newer", text: "new words" });
    expect(native.readDocumentSource).toHaveBeenCalledTimes(2);
  });
  it("refuses a different document kind detected from bytes", async () => {
    await textBook(); const before = getDocSource("book");
    vi.mocked(native.readDocumentSource).mockResolvedValue(bytes("%PDF-1.7"));
    await expect(linkDocSource("book", pick)).rejects.toThrow("That file is a different kind of document.");
    expect(getDocSource("book")).toEqual(before);
  });
  it("refuses a different document kind detected from the name", async () => {
    await textBook();
    vi.mocked(native.readDocumentSource).mockResolvedValue(bytes("old words"));
    await expect(linkDocSource("book", { ...pick, name: "notes.md" })).rejects.toThrow("That file is a different kind of document.");
  });
  it("unlinks without changing the app copy", async () => {
    await textBook();
    unlinkDocSource("book");
    expect(getDocSource("book")).toBeNull();
    expect((await getAnnotateDoc("book"))?.source).toBe("old words");
  });
  it("updates an unlinked document from a different picked file and saves its source", async () => {
    await textBook(); clearDocSource("book");
    vi.mocked(native.readDocumentSource).mockResolvedValue(bytes("new words"));
    const result = await linkDocSource("book", pick);
    if (result.status !== "differs") throw new Error("expected different content");
    await updateDocFromSource("book", result.content);
    expect((await getAnnotateDoc("book"))?.source).toBe("new words");
    expect(getDocSource("book")).toMatchObject({ ...pick, hash: hashMarkdown("new words") });
  });
  it("updates a linked document and replaces its old source only after a successful backup", async () => {
    await textBook(); const before = getDocSource("book");
    vi.mocked(native.readDocumentSource).mockResolvedValue(bytes("new words"));
    const result = await linkDocSource("book", pick);
    if (result.status !== "differs") throw new Error("expected different content");
    const retain = vi.spyOn(recovery, "retainRecoveryCopy").mockRejectedValueOnce(new Error("backup full"));
    await expect(updateDocFromSource("book", result.content)).rejects.toThrow("backup full");
    expect(getDocSource("book")).toEqual(before);
    expect((await getAnnotateDoc("book"))?.source).toBe("old words");
    retain.mockRestore();
    await updateDocFromSource("book", result.content);
    expect(getDocSource("book")).toMatchObject({ ...pick, hash: hashMarkdown("new words") });
  });
  it("rejects a source changed after a different file was picked", async () => {
    const hash = await textBook();
    vi.mocked(native.readDocumentSource).mockResolvedValue(bytes("new words"));
    const result = await linkDocSource("book", pick);
    if (result.status !== "differs") throw new Error("expected different content");
    setDocSource("book", { ...source(hash), location: "C:/another-source" });
    await expect(updateDocFromSource("book", result.content)).rejects.toThrow("source changed");
    expect((await getAnnotateDoc("book"))?.source).toBe("old words");
  });
  it("keeps a new source linked during backup instead of overwriting it", async () => {
    const hash = await textBook();
    vi.mocked(native.readDocumentSource).mockResolvedValue(bytes("new words"));
    const result = await linkDocSource("book", pick);
    if (result.status !== "differs") throw new Error("expected different content");
    const retain = recovery.retainRecoveryCopy;
    vi.spyOn(recovery, "retainRecoveryCopy").mockImplementation(async copy => {
      await retain(copy);
      setDocSource("book", { ...source(hash), location: "C:/another-source" });
    });
    await expect(updateDocFromSource("book", result.content)).rejects.toThrow("changed while");
    expect(getDocSource("book")?.location).toBe("C:/another-source");
    expect((await getAnnotateDoc("book"))?.source).toBe("old words");
  });
});

describe("updating from a source", () => {
  it("writes a complete backup before changing the same book's content or metadata", async () => {
    const oldHash = await textBook();
    await run(STORE_CONTENT, "readwrite", s => s.put({ board, pageCount: 1, extra: "child" }, "fnwb:book:child"));
    await putInkPages("md:book", [[2, encodeInkOps([])]]);
    await putInkPages("fnwb:book:child", [[1, encodeInkOps([])]]);
    const retain = recovery.retainRecoveryCopy;
    const backup = vi.spyOn(recovery, "retainRecoveryCopy").mockImplementation(async copy => {
      expect((await getAnnotateDoc("book"))?.hash).toBe(oldHash);
      expect((await getAnnotateDoc("book"))?.source).toBe("old words");
      expect(copy.record).toMatchObject({ meta: { id: "book", hash: oldHash }, payload: { source: "old words", board }, children: { child: { extra: "child" } } });
      expect(copy.record?.ink).toHaveLength(2);
      await retain(copy);
    });
    await updateDocFromSource("book", { status: "newer", text: "new words", ref: { ...source("unused"), size: 9, modified: 2 } });
    expect(backup).toHaveBeenCalledOnce();
    expect(await getAnnotateDoc("book")).toMatchObject({ id: "book", hash: docIdentityHash({ docType: "code", name: "notes.txt", text: "new words" }), source: "new words" });
    expect((await recovery.listRecoveryCopies("annotate", "book"))[0]?.record?.meta.hash).toBe(oldHash);
  });
  it("fails closed when the retained copy cannot be written", async () => {
    const oldHash = await textBook();
    const before = await captureBook({ kind: "annotate", id: "book" });
    vi.spyOn(recovery, "retainRecoveryCopy").mockRejectedValue(new Error("backup full"));
    await expect(updateDocFromSource("book", { status: "newer", text: "new words" })).rejects.toThrow("backup full");
    expect(await captureBook({ kind: "annotate", id: "book" })).toEqual(before);
    expect(getDocSource("book")?.hash).toBe(oldHash);
  });
  it("backs up binary bytes before storing new bytes and keeps the old file pinned", async () => {
    const old = bytes("%PDF-old"), next = bytes("%PDF-new");
    const oldHash = hashBytes(old), hash = hashBytes(next);
    await putDocBytes(oldHash, old);
    await saveAnnotateDoc({ id: "book", name: "book.pdf", hash: oldHash, docType: "pdf", source: "", board });
    setDocSource("book", source(oldHash));
    const retain = recovery.retainRecoveryCopy;
    vi.spyOn(recovery, "retainRecoveryCopy").mockImplementation(async (copy, requiredHash) => {
      expect(requiredHash).toBe(oldHash);
      expect(await getDocBytes(hash)).toBeNull(); expect(await getDocBytes(oldHash)).toEqual(old); await retain(copy, requiredHash);
    });
    await updateDocFromSource("book", { status: "newer", bytes: next });
    expect((await getAnnotateDoc("book"))?.hash).toBe(hash);
    expect(await getDocBytes(hash)).toEqual(next);
    await deleteDocBytes(oldHash); expect(await getDocBytes(oldHash)).toEqual(old);
    await clearDocBytes(); expect(await getDocBytes(oldHash)).toEqual(old);
  });
  it("a binary backup failure leaves metadata and both byte rows unchanged", async () => {
    const old = bytes("%PDF-old"), next = bytes("%PDF-new");
    await putDocBytes(hashBytes(old), old);
    await saveAnnotateDoc({ id: "book", name: "book.pdf", hash: hashBytes(old), docType: "pdf", source: "", board });
    setDocSource("book", source(hashBytes(old)));
    vi.spyOn(recovery, "retainRecoveryCopy").mockRejectedValue(new Error("backup full"));
    await expect(updateDocFromSource("book", { status: "newer", bytes: next })).rejects.toThrow("backup full");
    expect(await getDocBytes(hashBytes(next))).toBeNull(); expect(await getDocBytes(hashBytes(old))).toEqual(old);
    expect((await getAnnotateDoc("book"))?.hash).toBe(hashBytes(old));
  });
  it("reports removed PDF pages without changing ink or anchored marks", async () => {
    const old = bytes("%PDF-old"), next = bytes("%PDF-new");
    const note = { id: "note", kind: "note" as const, anchor: { kind: "text" as const, scope: "p2r", start: 0, end: 4 }, excerpt: "gone", createdAt: 1,
      subMarks: [{ id: "highlight", kind: "highlight" as const, start: 0, end: 4, excerpt: "gone" }] };
    await putDocBytes(hashBytes(old), old);
    await saveAnnotateDoc({ id: "book", name: "book.pdf", hash: hashBytes(old), docType: "pdf", source: "", board, footnotes: [note] });
    await putInkPages("md:book", [[2, encodeInkOps([{ kind: "draw", color: "#000000", baseWidth: 2, maxFullness: 1, pressureClip: .5, pressureSensitive: true, points: [{ x: 1, y: 1, pressure: .5 }] }])]]);
    setDocSource("book", source(hashBytes(old)));
    const beforeInk = await getInkPageRecords("md:book");
    const result = await updateDocFromSource("book", { status: "newer", bytes: next });
    expect(result.unplaced).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ink", page: 2 }), expect.objectContaining({ kind: "footnote", page: 2 }), expect.objectContaining({ kind: "highlight", page: 2 })]));
    expect(await getInkPageRecords("md:book")).toEqual(beforeInk);
    expect((await getAnnotateDoc("book"))?.footnotes?.[0]?.anchor).toEqual({ ...note.anchor, prefix: "", suffix: "" });
  });
  it("reports a missing text quote and its underline without deleting them", async () => {
    const hash = await textBook();
    const note = { id: "note", kind: "note" as const, anchor: { kind: "text" as const, start: 0, end: 3, exact: "old" }, excerpt: "old", createdAt: 1,
      subMarks: [{ id: "underline", kind: "underline" as const, start: 0, end: 3, excerpt: "old", anchor: { kind: "text" as const, start: 0, end: 3, exact: "old" } }] };
    await saveAnnotateDoc({ id: "book", name: "notes.txt", hash, docType: "code", source: "old words", board, footnotes: [note] });
    const result = await updateDocFromSource("book", { status: "newer", text: "different words" });
    expect(result.unplaced.map(row => row.kind)).toEqual(["footnote", "underline"]);
    expect((await getAnnotateDoc("book"))?.footnotes?.[0]?.anchor).toEqual({ ...note.anchor, prefix: "", suffix: "" });
  });
  it("keeps complete artifact revisions in the retained book", async () => {
    const hash = await textBook();
    const parent = { kind: "annotate" as const, id: "book" };
    const artifacts: ArtifactCatalog = { v: 1, parent, revision: "catalog", artifacts: [{ id: "attachment", revision: "artifact", title: "Note", createdAt: 1, updatedAt: 1,
      associations: [{ kind: "file" }], content: { kind: "markdown", documentId: "child-note", sourceRevision: "source" } }] };
    await putArtifactAsset({ parent, dependency: { kind: "document", id: "child-note", revision: "source" }, payload: JSON.stringify({
      v: 1, owned: true, docType: "markdown", name: "Note.md", source: "saved attachment", footnotes: [], agent: [], ink: [], board,
    }) });
    await saveAnnotateDoc({ id: "book", name: "notes.txt", hash, docType: "code", source: "old words", board, artifacts });
    await updateDocFromSource("book", { status: "newer", text: "new words" });
    const copy = (await recovery.listRecoveryCopies("annotate", "book"))[0];
    expect(copy.record?.payload.artifacts).toEqual(artifacts);
    expect((await getAnnotateDoc("book"))?.artifacts).toEqual(artifacts);
  });
  it("uses the renderer's text stream for quotes spanning HTML blocks", async () => {
    const text = "<p>alpha</p><p>beta</p>";
    const note = { id: "note", kind: "note" as const, anchor: { kind: "text" as const, start: 0, end: 10, exact: "alpha\nbeta" }, excerpt: "alpha\nbeta", createdAt: 1 };
    await saveAnnotateDoc({ id: "book", name: "notes.html", docType: "web", localFileHash: hashMarkdown(text), hash: hashMarkdown(text), source: text, board, footnotes: [note] });
    const ref = { ...source(hashMarkdown(text)), name: "notes.html" };
    setDocSource("book", ref);
    const result = await updateDocFromSource("book", { status: "newer", text, ref });
    expect(result.unplaced).toEqual([]);
  });
  it("refuses a replacement when current ink cannot be completely retained", async () => {
    const hash = await textBook();
    await saveAnnotateDoc({ id: "book", name: "notes.txt", hash, docType: "code", source: "old words", board: { ...board, inkPages: { v: 1, pageIds: [7] } } });
    const before = await captureBook({ kind: "annotate", id: "book" });
    await expect(updateDocFromSource("book", { status: "newer", text: "new words" })).rejects.toThrow("complete backup");
    expect(await captureBook({ kind: "annotate", id: "book" })).toEqual(before);
    expect(await recovery.listRecoveryCopies()).toEqual([]);
  });
  it("always releases live-session guards after a failed backup", async () => {
    await textBook();
    const release = vi.fn();
    const prepare = (event: Event) => (event as CustomEvent<{ releases: (() => void)[] }>).detail.releases.push(release);
    window.addEventListener(DOC_SOURCE_UPDATING_EVENT, prepare);
    vi.spyOn(recovery, "retainRecoveryCopy").mockRejectedValue(new Error("backup full"));
    try {
      await expect(updateDocFromSource("book", { status: "newer", text: "new words" })).rejects.toThrow("backup full");
      expect(release).toHaveBeenCalledOnce();
    } finally { window.removeEventListener(DOC_SOURCE_UPDATING_EVENT, prepare); }
  });
  it("captures live annotations without changing the active book before a successful backup", async () => {
    const hash = await textBook();
    const before = await captureBook({ kind: "annotate", id: "book" });
    const note = { id: "live", kind: "note" as const, anchor: { kind: "text" as const, start: 0, end: 3, exact: "old" }, excerpt: "old", createdAt: 1 };
    const prepare = (event: Event) => (event as CustomEvent<{ captures: Promise<unknown>[] }>).detail.captures.push(Promise.resolve({
      payload: { source: "old words", board, footnotes: [note], agent: [{ id: "live turn" }] }, pages: [],
    }));
    window.addEventListener(DOC_SOURCE_UPDATING_EVENT, prepare);
    const retain = vi.spyOn(recovery, "retainRecoveryCopy").mockRejectedValueOnce(new Error("backup full"));
    try {
      await expect(updateDocFromSource("book", { status: "newer", text: "new words" })).rejects.toThrow("backup full");
      expect(await captureBook({ kind: "annotate", id: "book" })).toEqual(before);
      expect(getDocSource("book")?.hash).toBe(hash);
      retain.mockRestore();
      await updateDocFromSource("book", { status: "newer", text: "new words" });
      const copy = (await recovery.listRecoveryCopies("annotate", "book"))[0];
      expect(copy.record?.payload).toMatchObject({ source: "old words", footnotes: [note], agent: [{ id: "live turn" }] });
      expect(copy.record?.wire).toMatchObject({ footnotes: [note] });
      expect(await getAnnotateDoc("book")).toMatchObject({ source: "new words", footnotes: [note] });
    } finally { window.removeEventListener(DOC_SOURCE_UPDATING_EVENT, prepare); }
  });
});

it("keeps device source locations out of the entire capture and built sync record", async () => {
  await textBook();
  const capture = await captureBook({ kind: "annotate", id: "book" });
  expect(capture.record).not.toBeNull();
  expect(JSON.stringify(capture)).not.toContain("location"); expect(JSON.stringify(capture)).not.toContain("C:/private");
});
