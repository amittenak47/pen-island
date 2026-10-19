import { docIdentityHash, getAnnotateDocMeta, hashMarkdown, isBinaryDocType, type DocType } from "./annotateStore";
import { getDocSource, setDocSource, type DocSourceRef } from "./docSourceStore";
import { readDocumentSource, statDocumentSource } from "./docSourceNative";
import { captureBook, type BookCapture } from "./bookSnapshot";
import { newBookToken } from "./bookCoordinator";
import { retainRecoveryCopy } from "./syncRecovery";
import { bytesMatchDocHash, getDocBytes, putDocBytesVerified } from "./docBytes";
import { listBookFallbacks, mutateLocalBook, notifyBookMetadataChanged } from "./localBookStore";
import { equalStored, recoveryId } from "./queueMigration";
import { STORE_CONTENT, STORE_INK_PAGES } from "./idb";
import { textAnchorOffsets, textOf, type DocAnchor } from "./docAnchors";
import { findQuote } from "./quoteAnchor";
import type { DocFootnote } from "./docFootnotes";
import { pageFromScope } from "./conflictPage";
import { authoredInkRow, encodedFromRecord, inkPageKey, type InkPageRecord } from "./inkPageStore";
import { packEncodedInk, summarizeEncodedInk } from "../canvas/inkCodec";
import { convertInlineBook } from "./bookInlineInk";
import { validatePackedInk } from "./syncContent";
import { artifactCatalogFields } from "./padArtifacts";
import { downloadArtifactAssets } from "./artifactAssetSync";

export const DOC_SOURCE_UPDATING_EVENT = "lc-doc-source-updating";
export const DOC_SOURCE_UPDATED_EVENT = "lc-doc-source-updated";
export const DOC_SOURCE_CHECKED_EVENT = "lc-doc-source-checked";
const updating = new Set<string>();

function sameSource(left: DocSourceRef | null, right: DocSourceRef): boolean {
  return left?.kind === right.kind && left.location === right.location;
}

export interface DocSourceCheck {
  status: "none" | "missing" | "same" | "newer";
  bytes?: ArrayBuffer;
  text?: string;
  ref?: DocSourceRef;
}

export interface UnplacedItem {
  kind: "ink" | "footnote" | "highlight" | "underline";
  label: string;
  page?: number;
}

export interface DocSourceLiveCapture {
  payload: Record<string, unknown>;
  pages: InkPageRecord[];
  children?: Record<string, Record<string, unknown>>;
}

export async function checkDocSource(id: string): Promise<DocSourceCheck> {
  const ref = getDocSource(id);
  if (!ref) return { status: "none" };
  const stat = await statDocumentSource(ref.kind, ref.location);
  if (!sameSource(getDocSource(id), ref)) throw new Error("The document's source changed while it was being checked. Check again.");
  if (!stat) return { status: "missing", ref };
  if (stat.size === ref.size && stat.modified === ref.modified) return { status: "same", ref };
  const meta = getAnnotateDocMeta(id);
  if (!meta) return { status: "none" };
  const bytes = await readDocumentSource(ref.kind, ref.location);
  const binary = isBinaryDocType(meta.docType);
  const original = binary ? undefined : new TextDecoder().decode(bytes);
  const localFileHash = meta.docType === "web" ? hashMarkdown(original!) : undefined;
  const hash = docIdentityHash({ docType: meta.docType, name: ref.name,
    ...(binary ? { bytes } : { text: original, localFileHash }) });
  const next = { ...ref, ...stat, hash, checkedAt: Date.now() };
  if (!sameSource(getDocSource(id), ref)) throw new Error("The document's source changed while it was being checked. Check again.");
  if (hash === getAnnotateDocMeta(id)?.hash) {
    setDocSource(id, next);
    return { status: "same", ref: next };
  }
  if (meta.docType === "web") {
    const { freezeLocalHtml } = await import("./localHtmlRender");
    return { status: "newer", text: await freezeLocalHtml(original!), ref: next };
  }
  return { status: "newer", ...(binary ? { bytes } : { text: original }), ref: next };
}

async function pdfPageCount(bytes: ArrayBuffer): Promise<number> {
  const { loadPdfJs, pdfJsDataUrls, pdfWorker } = await import("../modes/PdfDocument");
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), worker: pdfWorker(pdfjs), ...pdfJsDataUrls(), cMapPacked: true });
  try {
    return (await task.promise).numPages;
  } finally {
    await task.destroy();
  }
}

async function anchorText(text: string, docType: DocType): Promise<string> {
  if (typeof document === "undefined" || docType === "code") return text;
  const body = document.createElement("div");
  if (docType === "markdown") {
    const { renderMarkdown } = await import("../modes/AnnotateDocument");
    body.innerHTML = renderMarkdown(text);
  } else body.innerHTML = text;
  return textOf(body);
}

function pdfPage(anchor: DocAnchor): number | undefined {
  return pageFromScope(anchor.scope) ?? undefined;
}

async function unplacedAnnotations(capture: BookCapture, docType: DocType, content: DocSourceCheck): Promise<UnplacedItem[]> {
  const result: UnplacedItem[] = [];
  const count = docType === "pdf" ? await pdfPageCount(content.bytes!) : null;
  const text = !isBinaryDocType(docType) ? await anchorText(content.text!, docType) : null;
  const placed = (anchor: DocAnchor, quote: string) => {
    if (count !== null) {
      const page = pdfPage(anchor);
      return page === undefined ? !anchor.scope : page >= 1 && page <= count;
    }
    if (text === null) return true;
    if (anchor.kind !== "text") return !!quote && !!findQuote(text, { exact: quote });
    const found = textAnchorOffsets(text, { ...anchor, exact: anchor.exact || quote });
    return !!found && found.start >= 0 && found.end <= text.length;
  };
  if (count !== null) {
    const pages = [...capture.pages];
    if (capture.record) pages.push(...(await convertInlineBook(capture, capture.record, capture.state.changeSeq)).rows);
    const reported = new Set<number>();
    for (const page of pages) {
      if (page.docKey !== `md:${capture.id}` || page.pageId <= count || reported.has(page.pageId)) continue;
      const encoded = await encodedFromRecord(page);
      if (!encoded) throw new Error("The current handwriting cannot be read. Its retained copy was kept.");
      if (!summarizeEncodedInk(encoded).n) continue;
      reported.add(page.pageId);
      result.push({ kind: "ink", label: `Ink on page ${page.pageId}`, page: page.pageId });
    }
  }
  for (const note of (capture.payload?.footnotes ?? []) as DocFootnote[]) {
    if (!placed(note.anchor, note.blockText || note.excerpt)) result.push({ kind: "footnote", label: note.title || note.excerpt || "Footnote", page: pdfPage(note.anchor) });
    for (const mark of note.subMarks ?? []) {
      const found = !mark.anchor && text !== null ? !!findQuote(text, { exact: mark.excerpt }) : placed(mark.anchor ?? note.anchor, mark.excerpt);
      if (!found) result.push({ kind: mark.kind, label: mark.excerpt || mark.kind, page: pdfPage(mark.anchor ?? note.anchor) });
    }
  }
  return result;
}

export async function updateDocFromSource(id: string, content: DocSourceCheck): Promise<{ unplaced: UnplacedItem[] }> {
  if (updating.has(id)) throw new Error("This document is already being updated.");
  updating.add(id);
  const releases: (() => void)[] = [];
  try {
    const captures: Promise<DocSourceLiveCapture>[] = [];
    // Read live annotations without saving: backup failure must change nothing.
    if (typeof window !== "undefined") {
      const detail = { id, captures, releases };
      window.dispatchEvent(new CustomEvent(DOC_SOURCE_UPDATING_EVENT, { detail }));
    }
    return await replaceDocFromSource(id, content, await Promise.all(captures));
  } finally {
    for (const release of releases) release();
    updating.delete(id);
  }
}

async function replaceDocFromSource(id: string, content: DocSourceCheck, live: DocSourceLiveCapture[]): Promise<{ unplaced: UnplacedItem[] }> {
  const owner = { kind: "annotate" as const, id };
  if (listBookFallbacks().some(entry => entry.owner.kind === owner.kind && entry.owner.id === id)) {
    throw new Error("Resolve this document's saved local copies before updating it. The app's copy was kept.");
  }
  const capture = await captureBook(owner);
  const meta = capture.metadata;
  if (!meta || !capture.payload || meta.deletedAt !== undefined) throw new Error("This document is no longer in the library.");
  const docType = (meta.docType ?? "markdown") as DocType;
  const binary = isBinaryDocType(docType);
  if (binary ? !content.bytes?.byteLength : content.text === undefined) throw new Error("The newer document could not be read.");
  const ref = content.ref ?? getDocSource(id);
  if (!ref) throw new Error("This document has no source on this device.");
  if (!sameSource(getDocSource(id), ref)) throw new Error("The document's source changed. Check again before updating.");
  const hash = docIdentityHash({ docType, name: String(meta.name), bytes: binary ? content.bytes : undefined,
    text: content.text, ...(docType === "web" ? { localFileHash: ref.hash } : {}) });
  const current: DocSourceLiveCapture = { payload: {}, pages: [], children: {} };
  const livePages = new Map<string, InkPageRecord>();
  const merge = (target: Record<string, unknown>, values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) {
      if (Object.hasOwn(target, key) && !equalStored(target[key], value)) throw new Error("Open copies of this document differ. Keep one reading tab open before updating.");
      target[key] = value;
    }
  };
  for (const entry of live) {
    merge(current.payload, entry.payload);
    merge(current.children!, entry.children ?? {});
    for (const page of entry.pages) {
      const key = inkPageKey(page.docKey, page.pageId), previous = livePages.get(key);
      if (previous && !equalStored(previous.inkC, page.inkC)) throw new Error("Open copies of this handwriting differ. Keep one reading tab open before updating.");
      livePages.set(key, page);
    }
  }
  current.pages = [...livePages.values()];
  const pages = new Map(capture.pages.map(page => [inkPageKey(page.docKey, page.pageId), page]));
  for (const page of current.pages) pages.set(inkPageKey(page.docKey, page.pageId), page);
  const children = { ...capture.children };
  for (const [childId, child] of Object.entries(current.children!)) children[childId] = { ...children[childId], ...child };
  const retained: BookCapture = { ...capture, payload: { ...capture.payload, ...current.payload }, children, pages: [...pages.values()] };
  if (capture.record) retained.record = { ...capture.record, board: retained.payload!.board,
    source: retained.payload!.source, footnotes: retained.payload!.footnotes ?? [], agent: retained.payload!.agent ?? [],
    footnote_boards: retained.children };
  if (binary) {
    const bytes = typeof meta.hash === "string" ? await getDocBytes(meta.hash) : null;
    if (!bytes || !bytesMatchDocHash(String(meta.hash), bytes)) throw new Error("The current document's file is missing or incomplete; a complete backup cannot be kept.");
  }
  for (const page of retained.pages) {
    const encoded = await encodedFromRecord(page);
    if (!encoded) throw new Error("The current handwriting cannot be backed up. The document was kept.");
    validatePackedInk(packEncodedInk(encoded));
  }
  const requirePages = (value: unknown, key: string) => {
    const board = value as { v?: unknown; inkPages?: { pageIds?: unknown } } | null;
    if (!board || board.v !== 1 || (board.inkPages && (!Array.isArray(board.inkPages.pageIds)
      || board.inkPages.pageIds.some(pageId => !retained.pages.some(page => page.docKey === key && page.pageId === pageId))))) {
      throw new Error("The current handwriting is incomplete; a complete backup cannot be kept.");
    }
  };
  requirePages(retained.payload!.board, `md:${id}`);
  for (const [childId, child] of Object.entries(retained.children)) requirePages(child.board, `fnwb:${id}:${childId}`);
  await downloadArtifactAssets(undefined, artifactCatalogFields(retained.payload!.artifacts, owner).artifacts);
  // Nothing in the active book or byte store changes until this write commits.
  await retainRecoveryCopy({ id: recoveryId("document-source-update", STORE_CONTENT, newBookToken(), id), type: "record", kind: "annotate", bookId: id,
    provenance: { source: "document-source-update", retainedAt: Date.now() },
    record: { meta, payload: retained.payload!, children: retained.children, ink: retained.pages, wire: retained.record ?? undefined } }, binary ? String(meta.hash) : undefined);
  const unplaced = await unplacedAnnotations(retained, docType, content);
  if (binary) await putDocBytesVerified(hash, content.bytes!);
  const now = Date.now();
  await mutateLocalBook(owner, { requireIdb: true, extraStores: [STORE_INK_PAGES] }, ctx => {
    if (ctx.state.changeSeq !== capture.state.changeSeq || !equalStored(ctx.metadata, meta) || !equalStored(ctx.content, capture.payload)
      || !sameSource(getDocSource(id), ref)) {
      throw new Error("This document changed while its newer version was prepared. Check again; both copies were kept.");
    }
    ctx.setMetadata({ ...meta, hash, ...(docType === "web" ? { localFileHash: hash } : {}), updatedAt: Math.max(now, Number(meta.updatedAt ?? 0) + 1), lastTouch: now });
    ctx.setContent({ ...retained.payload, source: binary ? "" : content.text });
    for (const childId of Object.keys(current.children!)) ctx.tx!.objectStore(STORE_CONTENT).put(retained.children[childId], `fnwb:${id}:${childId}`);
    for (const page of current.pages) {
      const previous = capture.pages.find(row => row.docKey === page.docKey && row.pageId === page.pageId);
      ctx.tx!.objectStore(STORE_INK_PAGES).put(authoredInkRow(page, previous, ctx.seq), inkPageKey(page.docKey, page.pageId));
    }
  });
  setDocSource(id, { ...ref, hash, checkedAt: now });
  await notifyBookMetadataChanged("annotate", id);
  // Reload detaches this set from the old render, index and layout keys. Those
  // immutable caches remain usable by other sets and the retained version.
  if (typeof window !== "undefined") {
    const detail = { id, reloads: [] as Promise<void>[] };
    window.dispatchEvent(new CustomEvent(DOC_SOURCE_UPDATED_EVENT, { detail }));
    try { await Promise.all(detail.reloads); }
    catch { throw new Error("The updated copy was saved, but the reading tab could not reopen. Reopen it from Recents."); }
  }
  return { unplaced };
}
