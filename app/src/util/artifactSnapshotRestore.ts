import type { BoardBlob } from "../canvas/BoardHandle";
import { encodeInkOps, packEncodedInk, reviveEncodedInk } from "../canvas/inkCodec";
import { contentSpillOnly, getContent } from "./contentStore";
import { STORE_CONTENT, STORE_INK_PAGES, STORE_SYNC_RECOVERY, withStore } from "./idb";
import { newBookToken } from "./bookCoordinator";
import { hashMarkdown } from "./annotateStore";
import { editArtifactCatalog, ArtifactEditConflict } from "./artifactCatalogEdits";
import { stageArtifactSnapshot, type ArtifactSnapshotBundle } from "./artifactSnapshot";
import { downloadArtifactAssets } from "./artifactAssetSync";
import { annotateDocKey, authoredInkRow, encodedFromRecord, getInkPageRecords,
  inkPageKey, whiteboardDocKey, footnoteWhiteboardDocKey, type InkPageRecord } from "./inkPageStore";
import { parseSnapshotInk, snapshotInkToBytes } from "./padSnapshotPayload";
import type { PadSnapshot } from "./padSnapshotStore";
import type { ArtifactCatalog, ArtifactParent } from "./padArtifacts";
import { ARTIFACTS_CHANGED } from "./artifactRepository";
import { mutateLocalBook } from "./localBookStore";
import { validateInk, validatePackedInk } from "./syncContent";
import { preparePadRestore, finishPadRestore, type RestorePadOptions, type RestorePadResult } from "./padSync";
import { recordAuthoredExtras } from "./recordAuthoredExtras";

type SnapshotParent = ArtifactParent & { kind: "annotate" | "whiteboard" };
function validBoard(board: unknown): board is BoardBlob {
  const row = board as BoardBlob | undefined;
  return !!row && row.v === 1 && Array.isArray(row.elements) && !!row.appState && typeof row.appState === "object";
}

/** Capture all owned shards, including historic erasures and unreferenced children. */
async function currentInk(parent: SnapshotParent): Promise<InkPageRecord[]> {
  const primary = parent.kind === "annotate" ? annotateDocKey(parent.id) : whiteboardDocKey(parent.id);
  const rows = await getInkPageRecords(primary, { strict: true });
  if (parent.kind === "annotate") {
    const prefix = `fnwb:${parent.id}:`;
    await withStore(STORE_INK_PAGES, "readonly", store => {
      const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        rows.push(cursor.value as InkPageRecord);
        cursor.continue();
      };
    });
  }
  for (const row of rows) {
    const encoded = await encodedFromRecord(row);
    if (!encoded) throw new Error("Current handwriting is unreadable; the snapshot and current work were kept.");
    validatePackedInk(packEncodedInk(encoded));
  }
  return rows;
}

/** Metadata, content, children, ink and tracking share one local commit. */
export async function restorePadSnapshotLocally(parent: SnapshotParent, snap: Partial<PadSnapshot>, bundle?: ArtifactSnapshotBundle | null, options: RestorePadOptions = {}): Promise<RestorePadResult> {
  if (contentSpillOnly()) throw new Error("Repair local storage before restoring a snapshot.");
  if (!validBoard(snap.board)) throw new Error("Snapshot board is invalid; current work was kept.");
  const prepared = await preparePadRestore(parent, options);
  if (prepared.status === "stale") return { status: "stale" };
  const capturedState = prepared.capture.state;
  const bookRecord = (snap as Partial<PadSnapshot> & { bookRecord?: Record<string, unknown> }).bookRecord;
  const before = await getContent<{ artifacts?: ArtifactCatalog | null; [key: string]: unknown }>(parent.id);
  const fingerprint = JSON.stringify(before);
  const previousInk = await currentInk(parent);
  const previousChildren: Record<string, unknown> = {};
  if (parent.kind === "annotate") await withStore(STORE_CONTENT, "readonly", store => {
    const prefix = `fnwb:${parent.id}:`;
    const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { previousChildren[String(cursor.key)] = cursor.value; cursor.continue(); }
    };
  });
  let artifacts: ArtifactCatalog | undefined;
  if (bundle) {
    await stageArtifactSnapshot(bundle, parent);
    artifacts = editArtifactCatalog(before?.artifacts, parent, before?.artifacts?.revision ?? null,
      { type: "snapshot", catalog: bundle.catalog });
    await downloadArtifactAssets(undefined, artifacts);
  }
  const rows = new Map<string, InkPageRecord[]>();
  const primary = parent.kind === "annotate" ? annotateDocKey(parent.id) : whiteboardDocKey(parent.id);
  const addInk = async (docKey: string, value: unknown, board?: BoardBlob) => {
    const pages = parseSnapshotInk(value);
    if (value != null && (!Array.isArray(value) || pages.length !== value.length)) throw new Error("Snapshot ink is invalid; current work was kept.");
    const ids = new Set<number>();
    const prepared: InkPageRecord[] = [];
    for (const page of pages) {
      const decoded = snapshotInkToBytes(page);
      if (!decoded || !Number.isSafeInteger(page.pageId) || page.pageId < 0 || ids.has(page.pageId)) throw new Error("Snapshot ink is invalid; current work was kept.");
      ids.add(page.pageId);
      await validateInk(decoded.gz);
      prepared.push({ v: 1, docKey, pageId: page.pageId, gz: decoded.gz, dirty: false, updatedAt: page.updatedAt });
    }
    // Verify and convert older inline backups before replacing live shards.
    // Retain the original inline blob as well.
    if (value == null && board && (board.inkC !== undefined || board.ink !== undefined)) {
      const revived = board.inkC !== undefined ? reviveEncodedInk(board.inkC) : encodeInkOps(board.ink ?? []);
      if (!revived) throw new Error("Snapshot inline handwriting is unreadable; current work was kept.");
      // The historical reviver restores typed arrays but omits the layout tag.
      const encoded = { ...board.inkC, ...revived };
      validatePackedInk(packEncodedInk(encoded));
      prepared.push({ v: 1, docKey, pageId: docKey.startsWith("md:") ? 0 : 1,
        inkC: encoded, dirty: true, updatedAt: snap.writtenAt ?? Date.now() });
    }
    const available = new Set(prepared.map(page => page.pageId));
    if (board?.inkPages?.pageIds.some(id => !available.has(id))) throw new Error("Snapshot handwriting is incomplete; current work was kept.");
    rows.set(docKey, prepared);
  };
  await addInk(primary, snap.ink, snap.board);
  const childIds = new Set([...Object.keys(snap.footnoteBoards ?? {}), ...Object.keys(snap.footnoteInk ?? {})]);
  for (const id of childIds) {
    if (!id || id.includes(":")) throw new Error("Snapshot scratch-board identity is invalid.");
    const child = snap.footnoteBoards?.[id];
    if (!child || !validBoard(child.board)) throw new Error("Snapshot scratch board is missing; current work was kept.");
    await addInk(footnoteWhiteboardDocKey(parent.id, id), snap.footnoteInk?.[id], child.board);
  }
  const recoveredHash = parent.kind === "annotate" && typeof snap.source === "string" ? await hashMarkdown(snap.source) : undefined;
  const now = Date.now();
  await mutateLocalBook(parent, { requireIdb: true, extraStores: [STORE_INK_PAGES, STORE_SYNC_RECOVERY] }, ctx => {
    if (!ctx.tx || contentSpillOnly() || JSON.stringify(ctx.content) !== fingerprint
      || ctx.state.changeSeq !== (capturedState?.changeSeq ?? 1)) throw new ArtifactEditConflict();
    if (parent.kind === "annotate" && !ctx.metadata && recoveredHash === undefined && typeof bookRecord?.hash !== "string") {
      throw new Error("This backup's source identity is unavailable. Choose an existing document to restore it; the backup was kept.");
    }
    if (before || previousInk.length || Object.keys(previousChildren).length) {
      const id = `snapshot-restore:${newBookToken()}`;
      ctx.tx.objectStore(STORE_SYNC_RECOVERY).put({ id, type: "conflict", kind: parent.kind, bookId: parent.id,
        provenance: { source: "snapshot-restore", snapshotId: snap.snapshotId ?? null, retainedAt: Date.now() },
        ...(ctx.metadata && before && prepared.capture.record ? { record: { meta: ctx.metadata, payload: before,
          children: Object.fromEntries(Object.entries(previousChildren).map(([key, value]) => [key.slice(`fnwb:${parent.id}:`.length), value])),
          ink: previousInk, wire: prepared.capture.record } } : {}),
        content: { metadata: ctx.metadata, payload: before, children: previousChildren, ink: previousInk } }, id);
    }
    const restoredIdentity = bookRecord ? { authoredExtras: recordAuthoredExtras(bookRecord),
      ...(parent.kind === "annotate" ? { hash: bookRecord.hash, docType: bookRecord.doc_type,
        localFileHash: typeof bookRecord.local_file_hash === "string" ? bookRecord.local_file_hash : undefined,
        label: bookRecord.label } : {}) } : {};
    const meta = { ...ctx.metadata, ...restoredIdentity, ...parent, updatedAt: now, lastTouch: now,
      ...(parent.kind === "whiteboard" ? { title: snap.name ?? ctx.metadata?.title ?? "Recovered notebook",
        pageCount: snap.pageCount ?? ctx.metadata?.pageCount ?? 1 }
        : { name: snap.name ?? ctx.metadata?.name ?? "Recovered note.md",
          hash: bookRecord ? bookRecord.hash : ctx.metadata?.localFileHash || ["pdf", "epub"].includes(String(ctx.metadata?.docType))
            ? ctx.metadata?.hash : recoveredHash ?? ctx.metadata?.hash,
          docType: bookRecord?.doc_type ?? ctx.metadata?.docType ?? "markdown" }) };
    const seq = Math.max(Number(ctx.metadata?.syncSeq ?? 0), ctx.state.lifecycle?.seq ?? 0, prepared.goneSeq ?? 0) + 1;
    Object.assign(meta, { deletedAt: undefined, purgedAt: undefined, deleteAcked: false, deleteFollowed: undefined, syncSeq: seq });
    ctx.markLifecycle("restore", seq, prepared.baseBookRev, prepared.goneSeq);
    ctx.setMetadata(meta);
    ctx.setContent({ ...before, board: snap.board,
      artifacts: artifacts ?? before?.artifacts ?? null,
      agent: snap.agent ?? before?.agent ?? [],
      ...(parent.kind === "annotate" ? { source: snap.source ?? before?.source ?? "",
        footnotes: snap.footnotes ?? before?.footnotes ?? [] } : {}) });
    const content = ctx.tx.objectStore(STORE_CONTENT);
    if (parent.kind === "annotate") {
      const prefix = `fnwb:${parent.id}:`;
      content.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      for (const [id, scene] of Object.entries(snap.footnoteBoards ?? {})) content.put(scene, `fnwb:${parent.id}:${id}`);
    }
    const ink = ctx.tx.objectStore(STORE_INK_PAGES);
    const previousBy = new Map(previousInk.map(row => [inkPageKey(row.docKey, row.pageId), row]));
    const desired = new Map<string, InkPageRecord>();
    for (const [docKey, pages] of rows) for (const row of pages) desired.set(inkPageKey(docKey, row.pageId), row);
    for (const previous of previousInk) {
      const key = inkPageKey(previous.docKey, previous.pageId);
      if (!desired.has(key)) desired.set(key, { v: 1, docKey: previous.docKey, pageId: previous.pageId,
        inkC: encodeInkOps([]), dirty: true, updatedAt: now });
    }
    for (const [key, next] of desired) {
      const captured = previousBy.get(key);
      const request = ink.get(key);
      request.onsuccess = () => {
        const current = request.result as InkPageRecord | undefined;
        if ((current?.changeSeq ?? null) !== (captured?.changeSeq ?? null)
          || (current?.updatedAt ?? null) !== (captured?.updatedAt ?? null)) { ctx.tx!.abort(); return; }
        ink.put(authoredInkRow({ ...next, updatedAt: Math.max(now, (current?.updatedAt ?? 0) + 1) }, current, ctx.seq), key);
      };
    }
  });
  if (bundle && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(ARTIFACTS_CHANGED, { detail: parent }));
  return finishPadRestore(parent, prepared, options);
}

export async function restoreArtifactSnapshot(parent: SnapshotParent, snap: Partial<PadSnapshot>, bundle: ArtifactSnapshotBundle, options: RestorePadOptions = {}): Promise<RestorePadResult> {
  return restorePadSnapshotLocally(parent, snap, bundle, options);
}
