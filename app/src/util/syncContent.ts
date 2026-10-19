/** Atomic-sync content contract, mirrored by src/pads/sync_content.rs.
 * UTF-16 key order, ECMAScript finite-number formatting, no implicit omission.
 * Excludes root transport fields, board view/manifests and page-frame layout.
 * Empty defaults canonicalize to absence only at these paths: root agent
 * and footnote_boards; agent[].attachments/artifacts/artifactProposals/
 * flags/processEvents, agent[].pending/queued/bridgePending=false,
 * agent[].drawing.redacted=false, agent[].artifactProposals[].programs/messages;
 * footnotes[].notes/threads/bands/subMarks/userLinks/whiteboards/artifacts,
 * footnotes[].notes[].images and footnotes[].subMarks[].bands (lists use []).
 * Also empty strings at agent[].requestNote/reasoning/bridgeError,
 * footnotes[].title, .notes[].field, .userLinks[]/.whiteboards[].title and
 * .anchor/.subMarks[].anchor.prefix/suffix; board.files={} and
 * board.elements[].customData=null/{} (including footnote boards).
 * Also label=""; footnotes[].blockText/query/url/excerpt/color="", palette=[],
 * .notes[].by="" and .subMarks[].excerpt/color="", palette=[];
 * agent[].artifactFootnoteIds=null; board.inkPalettes=null and
 * board.appState.linedPaperMode/linedPitch/linedPitchWide/linedPitchCollege/linedRule=null.
 * Snapshots use these same defaults without view exclusions, plus empty
 * edges/footnoteBoards/footnoteInk and known-empty board.inkPages manifests.
 * Snapshot artifact payload JSON and retained bookRecord use the same record defaults.
 * Values are actual IEEE-754 JSON Numbers, not original decimal spellings.
 * A previously rounded JSON literal cannot be reconstructed by this helper.
 */
import { Gunzip } from "fflate";
import { b64ToBytes, bytesToB64 } from "../api/nativeHttp";

export const MAX_PACKED_INK_BYTES = 24 * 1024 * 1024;
export const MAX_INK_TRANSFER_BYTES = 32 * 1024 * 1024;
export const RECORD_TRANSPORT_KEYS = [
  "rev", "record_rev", "book_rev", "record_hash", "base_rev", "base_updated_at",
  "upload_id", "request_hash", "updated_at", "deleted_at", "sync_seq",
] as const;
export const LOCAL_VIEW_KEYS = ["scrollX", "scrollY", "zoom", "pdfPage", "pdfSpread"] as const;

function check(test: unknown, message: string): asserts test {
  if (!test) throw new Error(message);
}

function validString(value: string): void {
  // Rust JSON strings are Unicode scalar sequences; lone surrogates cannot be
  // passed through that contract losslessly even though JSON.stringify allows them.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      check(next >= 0xdc00 && next <= 0xdfff, "unpaired JSON surrogate");
    } else check(c < 0xdc00 || c > 0xdfff, "unpaired JSON surrogate");
  }
}

export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const visit = (value: unknown): string => {
    if (value === null) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") {
      check(Number.isFinite(value), "nonfinite JSON number");
      return JSON.stringify(value);
    }
    if (typeof value === "string") { validString(value); return JSON.stringify(value); }
    check(typeof value === "object", "unsupported JSON value");
    check(!active.has(value), "cyclic JSON value");
    active.add(value);
    try {
      if (Array.isArray(value)) {
        const keys = Object.keys(value);
        check(keys.length === value.length && keys.every((key, index) => key === String(index))
          && Object.getOwnPropertySymbols(value).length === 0, "sparse or decorated JSON array");
        return `[${value.map(visit).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      check(prototype === Object.prototype || prototype === null, "non-JSON object");
      check(Object.getOwnPropertySymbols(value).length === 0, "symbol JSON property");
      return `{${Object.keys(value).sort().map(key => {
        validString(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        check("value" in descriptor, "accessor JSON property");
        return `${JSON.stringify(key)}:${visit(descriptor.value)}`;
      }).join(",")}}`;
    } finally { active.delete(value); }
  };
  return visit(value);
}

/** Each device lays out the document page frame itself: its size comes from
 * that screen's layout and its version stamps from the editor. Handwriting
 * carries its own layout tag; the record's width is only a hint for pages
 * saved before tags, and sync keeps each device's own frame on download. */
export const PAGE_FRAME_LOCAL_KEYS = ["width", "height", "version", "versionNonce", "updated", "seed"] as const;
/** Agent message flags whose `false` is the same as leaving them out. */
export const MESSAGE_FALSE_DEFAULT_KEYS = ["pending", "queued", "bridgePending"] as const;
export const MESSAGE_EMPTY_LIST_KEYS = ["attachments", "artifacts", "artifactProposals", "flags", "processEvents"] as const;
export const MESSAGE_EMPTY_STRING_KEYS = ["requestNote", "reasoning", "bridgeError"] as const;
export const FOOTNOTE_EMPTY_LIST_KEYS = ["notes", "threads", "bands", "subMarks", "userLinks", "whiteboards", "artifacts"] as const;

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

function isPageFrame(element: Record<string, unknown>): boolean {
  if (element.id === "lcmdink-0-frame") return true;
  const meta = element.customData;
  if (!plainObject(meta)) return false;
  return meta.lcMdInkFrame === true || meta.lcDocumentPage === true || (meta.lcRegionFrame === true && meta.lcRegion === "mdink-0");
}

function emptyStrings(row: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) if (row[key] === "") delete row[key];
}

function emptyMap(row: Record<string, unknown>, key: string): void {
  if (plainObject(row[key]) && Object.keys(row[key]).length === 0) delete row[key];
}

/** Only named empty defaults; snapshots retain view state and populated manifests. */
function normalizeEmptyDefaults(record: Record<string, unknown>, snapshot = false, snapshotPayload = snapshot): void {
  emptyStrings(record, ["label"]);
  const board = (value: unknown) => {
    if (!plainObject(value)) return;
    emptyMap(value, "files");
    if (value.inkPalettes === null) delete value.inkPalettes;
    if (plainObject(value.appState)) for (const key of ["linedPaperMode", "linedPitch", "linedPitchWide", "linedPitchCollege", "linedRule"]) {
      if (value.appState[key] === null) delete value.appState[key];
    }
    if (Array.isArray(value.elements)) for (const element of value.elements) {
      if (!plainObject(element)) continue;
      if (element.customData === null) delete element.customData;
      emptyMap(element, "customData");
    }
    const manifest = value.inkPages;
    if (snapshot && plainObject(manifest) && manifest.v === 1 && Array.isArray(manifest.pageIds)
      && manifest.pageIds.length === 0 && Object.keys(manifest).every(key => key === "v" || key === "pageIds")) delete value.inkPages;
  };
  board(record.board);
  for (const key of ["footnote_boards", ...(snapshotPayload ? ["footnoteBoards"] : [])]) {
    const children = record[key];
    if (plainObject(children)) for (const child of Object.values(children)) {
      if (plainObject(child)) board(child.board);
    }
    emptyMap(record, key);
  }
  if (Array.isArray(record.agent)) for (const message of record.agent) {
    if (plainObject(message)) {
      emptyStrings(message, MESSAGE_EMPTY_STRING_KEYS);
      if (message.artifactFootnoteIds === null) delete message.artifactFootnoteIds;
    }
  }
  const anchor = (value: unknown) => {
    if (plainObject(value) && value.kind !== "region") emptyStrings(value, ["prefix", "suffix"]);
  };
  if (Array.isArray(record.footnotes)) for (const note of record.footnotes) {
    if (!plainObject(note)) continue;
    emptyStrings(note, ["title", "blockText", "query", "url", "excerpt", "color"]);
    if (Array.isArray(note.palette) && note.palette.length === 0) delete note.palette;
    anchor(note.anchor);
    for (const key of ["userLinks", "whiteboards", "notes", "subMarks"]) {
      const entries = note[key];
      if (Array.isArray(entries)) for (const entry of entries) {
        if (!plainObject(entry)) continue;
        if (key === "subMarks") {
          anchor(entry.anchor);
          emptyStrings(entry, ["excerpt", "color"]);
          if (Array.isArray(entry.palette) && entry.palette.length === 0) delete entry.palette;
        } else emptyStrings(entry, key === "notes" ? ["field", "by"] : ["title"]);
      }
    }
  }
  if (snapshotPayload) {
    if (Array.isArray(record.edges) && record.edges.length === 0) delete record.edges;
    emptyMap(record, "footnoteInk");
  }
}

export function normalizeRecord(value: unknown): Record<string, unknown> {
  check(value != null && typeof value === "object" && !Array.isArray(value), "book record must be an object");
  const record = JSON.parse(canonicalJson(value)) as Record<string, unknown>;
  normalizeEmptyDefaults(record);
  for (const key of RECORD_TRANSPORT_KEYS) delete record[key];
  const emptyLists = (row: Record<string, unknown>, keys: readonly string[]) => {
    for (const key of keys) if (Array.isArray(row[key]) && row[key].length === 0) delete row[key];
  };
  const board = (value: unknown) => {
    if (!plainObject(value)) return;
    const row = value;
    delete row.inkPages;
    if (plainObject(row.appState)) {
      for (const key of LOCAL_VIEW_KEYS) delete row.appState[key];
      // A camera-only addition has no shared state after exclusions.
      if (Object.keys(row.appState).length === 0) delete row.appState;
    }
    if (Array.isArray(row.elements)) for (const element of row.elements) {
      if (plainObject(element) && isPageFrame(element)) for (const key of PAGE_FRAME_LOCAL_KEYS) delete element[key];
    }
  };
  board(record.board);
  if (plainObject(record.footnote_boards)) {
    for (const value of Object.values(record.footnote_boards)) {
      if (plainObject(value)) board(value.board);
    }
    // The book format defaults an absent map to empty.
    if (Object.keys(record.footnote_boards).length === 0) delete record.footnote_boards;
  }
  if (Array.isArray(record.agent)) for (const message of record.agent) {
    if (!plainObject(message)) continue;
    emptyLists(message, MESSAGE_EMPTY_LIST_KEYS);
    for (const key of MESSAGE_FALSE_DEFAULT_KEYS) if (message[key] === false) delete message[key];
    if (plainObject(message.drawing) && message.drawing.redacted === false) delete message.drawing.redacted;
    if (Array.isArray(message.artifactProposals)) for (const proposal of message.artifactProposals) {
      if (plainObject(proposal)) emptyLists(proposal, ["programs", "messages"]);
    }
  }
  if (Array.isArray(record.footnotes)) for (const note of record.footnotes) {
    if (!plainObject(note)) continue;
    emptyLists(note, FOOTNOTE_EMPTY_LIST_KEYS);
    if (Array.isArray(note.notes)) for (const entry of note.notes) {
      if (plainObject(entry)) emptyLists(entry, ["images"]);
    }
    if (Array.isArray(note.subMarks)) for (const mark of note.subMarks) {
      if (plainObject(mark)) emptyLists(mark, ["bands"]);
    }
  }
  emptyLists(record, ["agent"]);
  return record;
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  check(typeof globalThis.crypto?.subtle?.digest === "function", "SHA-256 is unavailable on this device");
  const owned = new Uint8Array(bytes);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", owned);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function recordHash(value: unknown): Promise<string> {
  return hashBytes(new TextEncoder().encode(canonicalJson(normalizeRecord(value))));
}

/** Immutable backup identity preserves view state, authored source and unknown
 * fields. Safe empty defaults, known ink encodings and artifact JSON strings
 * have representational normalization.
 */
export async function normalizeSnapshotCopy(value: { tier: string; payload: unknown }): Promise<{ tier: string; payload: unknown }> {
  check(typeof value.tier === "string", "snapshot tier must be a string");
  const payload = JSON.parse(canonicalJson(value.payload)) as unknown;
  check(payload === null || typeof payload === "object" && !Array.isArray(payload), "snapshot payload must be an object");
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const row = payload as Record<string, unknown>;
    normalizeEmptyDefaults(row, true);
    if (plainObject(row.bookRecord)) normalizeEmptyDefaults(row.bookRecord, true, false);
    const ink = async (value: unknown) => {
      check(Array.isArray(value), "snapshot ink must be an array");
      for (const item of value) {
        const page = object(item, "snapshot ink page must be an object");
        check(typeof page.pageId === "number" && Number.isInteger(page.pageId)
          && typeof page.updatedAt === "number" && Number.isInteger(page.updatedAt), "invalid snapshot ink page metadata");
        check(typeof page.gz === "string" && page.gz.length > 0, "snapshot ink page needs gz");
        const bytes = b64ToBytes(page.gz);
        check(bytesToB64(bytes) === page.gz, "snapshot ink is not canonical base64");
        page.gz = bytesToB64((await validateInk(bytes)).packed);
      }
    };
    if (Object.hasOwn(row, "ink")) await ink(row.ink);
    if (Object.hasOwn(row, "footnoteInk")) {
      for (const pages of Object.values(object(row.footnoteInk, "snapshot footnote ink must be an object"))) await ink(pages);
    }
    if (Object.hasOwn(row, "artifactBundle")) {
      const assets = object(row.artifactBundle, "invalid snapshot artifact bundle").assets;
      check(Array.isArray(assets), "missing backup assets");
      for (const value of assets) {
        const asset = object(value, "invalid backup asset");
        check(typeof asset.payload === "string", "invalid backup asset payload");
        const parsed: unknown = JSON.parse(asset.payload);
        if (plainObject(parsed)) normalizeEmptyDefaults(parsed, true, false);
        asset.payload = canonicalJson(parsed);
      }
    }
  }
  return { tier: value.tier, payload };
}

export async function snapshotCopyHash(value: { tier: string; payload: unknown }): Promise<string> {
  return hashBytes(new TextEncoder().encode(canonicalJson(await normalizeSnapshotCopy(value))));
}

function object(value: unknown, message: string): Record<string, unknown> {
  check(value != null && typeof value === "object" && !Array.isArray(value), message);
  return value as Record<string, unknown>;
}

function finite(value: Record<string, unknown>, field: string): number {
  check(typeof value[field] === "number" && Number.isFinite(value[field]), `invalid ink ${field}`);
  return value[field] as number;
}

function count(value: Record<string, unknown>, field: string, optional = false): number {
  if (optional && !Object.hasOwn(value, field)) return 0;
  const n = finite(value, field);
  check(Number.isSafeInteger(n) && n >= 0 && n <= MAX_PACKED_INK_BYTES, `invalid ink ${field}`);
  return n;
}

function optionalNumbers(value: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) if (Object.hasOwn(value, field)) finite(value, field);
}

/** Validate all counts/bounds before the permissive historical codec allocates. */
export function validatePackedInk(packed: Uint8Array): { isEmpty: boolean } {
  check(packed.length <= MAX_PACKED_INK_BYTES, "ink exceeds expanded limit");
  check(packed.length >= 12, "invalid packed ink header");
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  check(view.getUint32(0, true) === 0x436b6e69, "invalid packed ink header");
  check(view.getUint32(4, true) === 1, "invalid packed ink envelope version");
  const metaLength = view.getUint32(8, true);
  check(metaLength <= packed.length - 12, "truncated packed ink metadata");
  const meta = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packed.subarray(12, 12 + metaLength))), "invalid packed ink metadata");
  check(Array.isArray(meta.meta), "invalid packed ink operations");
  let offset = 12 + metaLength;
  let isEmpty = true;
  for (const value of meta.meta) {
    const op = object(value, "invalid ink operation");
    check(op.k === "d" || op.k === "e", "invalid ink operation kind");
    isEmpty &&= op.k !== "d";
    finite(op, "x0"); finite(op, "y0");
    const n = count(op, "n");
    check(n > 0, "invalid ink point count");
    const xy = count(op, "xyN"), pr = count(op, "prN"), sl = count(op, "slN"), rr = count(op, "rrN", true);
    check(xy === (n - 1) * 2 && (pr === 0 || pr === n) && (sl === 0 || sl === n) && (rr === 0 || rr === n), "invalid ink buffer counts");
    optionalNumbers(op, ["w", "f", "pc", "ps", "si", "sbb", "btg", "sf", "gr", "ib", "hl", "ht", "hk", "hsl", "hst", "i", "s", "r"]);
    if (Object.hasOwn(op, "c")) check(typeof op.c === "string", "invalid ink color");
    if (Object.hasOwn(op, "bh")) {
      check(Array.isArray(op.bh), "invalid ink pooling stamps");
      for (const value of op.bh) {
        const halt = object(value, "invalid pooling stamp");
        finite(halt, "x"); finite(halt, "y"); finite(halt, "g"); optionalNumbers(halt, ["p", "s"]);
      }
    }
    offset += xy * 2 + pr + sl + rr * 2;
    check(offset <= packed.length, "truncated packed ink buffers");
  }
  check(offset === packed.length, "trailing packed ink bytes");
  if (Object.hasOwn(meta, "raw")) {
    check(Array.isArray(meta.raw), "invalid raw ink operations");
    for (const value of meta.raw) {
      const op = object(value, "invalid raw ink operation");
      check(op.kind === "draw" || op.kind === "erase", "invalid raw ink kind");
      isEmpty &&= op.kind !== "draw";
      check(Array.isArray(op.points), "invalid raw ink points");
      for (const value of op.points) {
        const point = object(value, "invalid raw ink point");
        finite(point, "x"); finite(point, "y"); optionalNumbers(point, ["pressure", "slowness", "radius"]);
      }
      optionalNumbers(op, ["baseWidth", "maxFullness", "pressureClip", "speedInk", "speedBlotBlend", "blotTipGrow", "speedFade", "grain", "boldness", "hostKey", "scrollLeftAtDraw", "scrollTopAtDraw", "id", "seq", "radius"]);
      if (Object.hasOwn(op, "color")) check(typeof op.color === "string", "invalid raw ink color");
      for (const key of ["pressureSensitive", "highlight", "highlightTips"]) {
        if (Object.hasOwn(op, key)) check(typeof op[key] === "boolean", "invalid raw ink style");
      }
      if (Object.hasOwn(op, "blotHalts")) {
        check(Array.isArray(op.blotHalts), "invalid raw pooling stamps");
        for (const value of op.blotHalts) {
          const halt = object(value, "invalid raw pooling stamp");
          finite(halt, "x"); finite(halt, "y"); finite(halt, "grow"); optionalNumbers(halt, ["pressure", "slowness"]);
        }
      }
    }
  }
  if (Object.hasOwn(meta, "layout")) {
    const layout = object(meta.layout, "invalid ink layout");
    check(finite(layout, "w") > 0 && typeof layout.spread === "boolean", "invalid ink layout");
  }
  return { isEmpty };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function unpackInk(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  check(bytes.length <= MAX_INK_TRANSFER_BYTES, "ink exceeds transfer limit");
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    check(bytes.length <= MAX_PACKED_INK_BYTES, "ink exceeds expanded limit");
    return new Uint8Array(bytes);
  }
  check(bytes.length >= 18 && bytes[2] === 8 && (bytes[3] & 0xe0) === 0, "invalid compressed ink header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let headerEnd = 10;
  if (bytes[3] & 4) {
    check(headerEnd + 2 <= bytes.length - 8, "truncated compressed ink header");
    headerEnd += 2 + view.getUint16(headerEnd, true);
  }
  for (const flag of [8, 16]) if (bytes[3] & flag) {
    while (headerEnd < bytes.length - 8 && bytes[headerEnd] !== 0) headerEnd++;
    check(headerEnd < bytes.length - 8, "truncated compressed ink header");
    headerEnd++;
  }
  if (bytes[3] & 2) {
    check(headerEnd + 2 <= bytes.length - 8, "truncated compressed ink header");
    check(view.getUint16(headerEnd, true) === (crc32(bytes.subarray(0, headerEnd)) & 0xffff), "invalid compressed ink header CRC");
    headerEnd += 2;
  }
  check(headerEnd < bytes.length - 8, "truncated compressed ink header");
  const size = view.getUint32(bytes.length - 4, true);
  check(size <= MAX_PACKED_INK_BYTES, "ink exceeds expanded limit");
  // fflate intentionally omits CRC validation. Stream small input chunks to
  // enforce the expanded bound, then verify footer size/CRC explicitly.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const stream = new Gunzip((chunk) => {
    total += chunk.length;
    check(total <= MAX_PACKED_INK_BYTES, "ink exceeds expanded limit");
    chunks.push(chunk);
  });
  stream.onmember = () => { throw new Error("multiple compressed ink members"); };
  for (let offset = 0; offset < bytes.length; offset += 256) {
    stream.push(bytes.subarray(offset, offset + 256), offset + 256 >= bytes.length);
  }
  check(total === size, "invalid compressed ink size");
  const packed = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { packed.set(chunk, offset); offset += chunk.length; }
  check(crc32(packed) === view.getUint32(bytes.length - 8, true), "invalid compressed ink CRC");
  return packed;
}

export async function validateInk(bytes: Uint8Array): Promise<{ packed: Uint8Array<ArrayBuffer>; wireHash: string; isEmpty: boolean }> {
  const packed = unpackInk(bytes);
  const { isEmpty } = validatePackedInk(packed);
  return { packed, wireHash: await hashBytes(packed), isEmpty };
}

export async function wireInkHash(bytes: Uint8Array): Promise<string> {
  return (await validateInk(bytes)).wireHash;
}
