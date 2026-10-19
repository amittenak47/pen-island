/** Explicit retained-copy choices create a new authored version and publish it when online. */
import { readRecoveryCopy, type RecoveryCopy } from "./syncRecovery";
import { STORE_CONTENT, STORE_INK_PAGES, STORE_SYNC_RECOVERY, run, withStore } from "./idb";
import { type BookIdentity, type BookMeta } from "./syncState";
import { mutateLocalBook, ensureBookReadyForAtomicSync } from "./localBookStore";
import { newBookToken, hasBookLocks } from "./bookCoordinator";
import { getDocBytes } from "./docBytes";
import { artifactCatalogFields } from "./padArtifacts";
import { downloadArtifactAssets } from "./artifactAssetSync";
import { authoredInkRow, encodedFromRecord, getInkPageRecords, inkPageKey, type InkPageRecord } from "./inkPageStore";
import { packEncodedInk } from "../canvas/inkCodec";
import { validatePackedInk } from "./syncContent";
import { notifyBookMetadataChanged } from "./localBookStore";
import { preparePadRestore, finishPadRestore, type RestorePadOptions } from "./padSync";
import { encodeInkOps } from "../canvas/inkCodec";

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function board(value: unknown): value is Record<string, unknown> {
  return object(value) && value.v === 1 && Array.isArray(value.elements) && object(value.appState);
}
export async function restoreRetainedRecord(id: string, options: RestorePadOptions = {}): Promise<(BookIdentity & { status: "restored" | "queued" }) | { status: "stale" }> {
  const copy = await readRecoveryCopy(id);
  if (!copy || !copy.kind || !copy.bookId) throw new Error("This retained copy is not a complete book.");
  const owner = { kind: copy.kind, id: copy.bookId };
  if (hasBookLocks()) await ensureBookReadyForAtomicSync(owner);
  let record = copy.record;
  if (!record && copy.type === "conflict" && object(copy.content) && object(copy.content.metadata) && object(copy.content.payload)) {
    const prefix = `fnwb:${owner.id}:`, children = object(copy.content.children) ? copy.content.children : {};
    record = { meta: copy.content.metadata as BookMeta, payload: copy.content.payload,
      children: Object.fromEntries(Object.entries(children).map(([key, child]) => [key.startsWith(prefix) ? key.slice(prefix.length) : key, child])),
      ...(Array.isArray(copy.content.ink) ? { ink: copy.content.ink as InkPageRecord[] } : {}) };
  }
  if (!record || !["record", "conflict"].includes(copy.type)) throw new Error("This retained copy is not a complete book.");
  if (record.meta.kind !== owner.kind || record.meta.id !== owner.id || !board(record.payload.board)) throw new Error("This retained book is unreadable. The copy was kept.");
  const prepared = await preparePadRestore(owner, options);
  if (prepared.status === "stale") return { status: "stale" };
  const capturedState = prepared.capture.state;
  const contentStore = owner.kind === "problem" ? "problem_boards" : STORE_CONTENT;
  const current = await run(contentStore, "readonly", store => store.get(owner.id));
  const children: Record<string, unknown> = {};
  const ink: InkPageRecord[] = [];
  if (owner.kind !== "problem") ink.push(...await getInkPageRecords(`${owner.kind === "annotate" ? "md" : "wb"}:${owner.id}`, { strict: true }));
  if (owner.kind === "annotate") {
    const prefix = `fnwb:${owner.id}:`;
    await withStore(STORE_CONTENT, "readonly", store => {
      const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => { const cursor = request.result; if (cursor) { children[String(cursor.key)] = cursor.value; cursor.continue(); } };
    });
    await withStore(STORE_INK_PAGES, "readonly", store => {
      const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => { const cursor = request.result; if (cursor) { ink.push(cursor.value); cursor.continue(); } };
    });
  }
  const restoreInk = record.ink ?? ink;
  for (const page of restoreInk) {
    const encoded = await encodedFromRecord(page);
    if (!encoded) throw new Error("Current handwriting cannot be read. Both copies were kept.");
    validatePackedInk(packEncodedInk(encoded));
  }
  const requirePages = (scene: unknown, docKey: string) => {
    if (!board(scene)) throw new Error("A retained scratch board is unreadable. The copy was kept.");
    const manifest = scene.inkPages;
    if (manifest !== undefined && (!object(manifest) || !Array.isArray(manifest.pageIds)
      || manifest.pageIds.some(pageId => !restoreInk.some(page => page.docKey === docKey && page.pageId === pageId)))) {
      throw new Error("This retained copy references missing handwriting. Its original data was kept.");
    }
  };
  if (owner.kind !== "problem") requirePages(record.payload.board, `${owner.kind === "annotate" ? "md" : "wb"}:${owner.id}`);
  for (const [childId, child] of Object.entries(record.children ?? {})) {
    if (owner.kind !== "annotate" || !childId || childId.includes(":") || !object(child)) throw new Error("This retained scratch-board identity is invalid.");
    requirePages(child.board, `fnwb:${owner.id}:${childId}`);
  }
  if (owner.kind === "annotate") {
    const footnotes = record.payload.footnotes;
    if (footnotes !== undefined && !Array.isArray(footnotes)) throw new Error("This retained book's footnotes are unreadable. The copy was kept.");
    for (const footnote of Array.isArray(footnotes) ? footnotes : []) {
      if (!object(footnote)) throw new Error("This retained footnote is unreadable. The copy was kept.");
      for (const reference of Array.isArray(footnote.whiteboards) ? footnote.whiteboards : []) {
        if (!object(reference) || typeof reference.id !== "string" || !record.children?.[reference.id]) {
          throw new Error("This retained book references a missing scratch board. The copy was kept.");
        }
      }
    }
  }
  if (owner.kind === "annotate" && ["pdf", "epub"].includes(String(record.meta.docType))) {
    if (typeof record.meta.hash !== "string" || !await getDocBytes(record.meta.hash)) throw new Error("This retained book's source file is missing. The copy was kept.");
  }
  const catalog = artifactCatalogFields(record.payload.artifacts, owner).artifacts;
  await downloadArtifactAssets(undefined, catalog);
  await mutateLocalBook(owner, { requireIdb: true, contentStore, extraStores: [STORE_CONTENT, STORE_INK_PAGES, STORE_SYNC_RECOVERY] }, ctx => {
    if (!ctx.tx || JSON.stringify(ctx.content) !== JSON.stringify(current ?? null)
      || ctx.state.changeSeq !== (capturedState?.changeSeq ?? 1)) throw new Error("This book changed while its retained copy was prepared. Both copies were kept.");
    // Preserve the losing local alternative before replacing any active reference.
    if (ctx.content || ctx.metadata || ink.length || Object.keys(children).length) {
      const retained: RecoveryCopy = { id: `restore-alternative:${newBookToken()}`, type: "conflict", ...{ kind: owner.kind, bookId: owner.id },
        provenance: { source: "explicit-recovery-restore", recoveryId: id, retainedAt: Date.now() },
        content: { metadata: ctx.metadata, payload: ctx.content, children, ink } };
      ctx.tx.objectStore(STORE_SYNC_RECOVERY).add(retained, retained.id);
    }
    const metadata: BookMeta = { ...record.meta, ...owner, deletedAt: undefined, purgedAt: undefined, deleteFollowed: undefined,
      deleteAcked: false, updatedAt: Date.now(), lastTouch: Date.now(), syncSeq: Math.max(Number(record.meta.syncSeq ?? 0), Number(ctx.metadata?.syncSeq ?? 0), ctx.state.lifecycle?.seq ?? 0, prepared.goneSeq ?? 0) + 1 };
    ctx.setMetadata(metadata);
    ctx.setContent(owner.kind === "problem" ? { ...metadata, ...record.payload } : record.payload);
    // A choice between the hub's own disagreeing versions: the next sync
    // commits it over that hub record (see `inlineChoiceHubHash`).
    const hubRecordHash = (copy.provenance as { hubRecordHash?: unknown } | undefined)?.hubRecordHash;
    if (typeof hubRecordHash === "string") ctx.setState({ ...ctx.state, inlineChoiceHubHash: hubRecordHash });
    if (owner.kind === "annotate") ctx.tx.objectStore(STORE_CONTENT).delete(IDBKeyRange.bound(`fnwb:${owner.id}:`, `fnwb:${owner.id}:\uffff`));
    for (const [childId, child] of Object.entries(record.children ?? {})) ctx.tx.objectStore(STORE_CONTENT).put(child, `fnwb:${owner.id}:${childId}`);
    const desiredInk = [...restoreInk];
    if (record.ink) for (const previous of ink) if (!desiredInk.some(page => page.docKey === previous.docKey && page.pageId === previous.pageId)) {
      desiredInk.push({ v: 1, docKey: previous.docKey, pageId: previous.pageId, inkC: encodeInkOps([]), dirty: true, updatedAt: Date.now() });
    }
    if (record.ink) for (const page of desiredInk) {
      const current = ink.find(row => row.docKey === page.docKey && row.pageId === page.pageId);
      ctx.tx.objectStore(STORE_INK_PAGES).put(authoredInkRow({ ...page,
        updatedAt: Math.max(Date.now(), (current?.updatedAt ?? 0) + 1) }, current, ctx.seq), inkPageKey(page.docKey, page.pageId));
    }
    ctx.markLifecycle("restore", Number(metadata.syncSeq), prepared.baseBookRev, prepared.goneSeq);
  });
  await notifyBookMetadataChanged(owner.kind, owner.id);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("lc-pad-hub", { detail: { ...owner, op: "reload" } }));
  const result = await finishPadRestore(owner, prepared, options);
  return result.status === "stale" ? result : { ...owner, status: result.status };
}

/** Export binary values without silently serializing them to empty JSON objects. */
export async function recoveryExportValue(value: unknown): Promise<unknown> {
  if (value instanceof ArrayBuffer) return { type: "ArrayBuffer", bytes: [...new Uint8Array(value)] };
  if (ArrayBuffer.isView(value)) return { type: value.constructor.name, bytes: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)] };
  if (typeof Blob !== "undefined" && value instanceof Blob) return { type: "Blob", mimeType: value.type, bytes: [...new Uint8Array(await value.arrayBuffer())] };
  if (Array.isArray(value)) return Promise.all(value.map(recoveryExportValue));
  if (object(value)) return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await recoveryExportValue(item)])));
  return value;
}
