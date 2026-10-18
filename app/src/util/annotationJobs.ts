/**
 * Page-range ChatBot runs on this device.
 *
 * The device sends the text of a run of pages; an assistant answers each page
 * with footnote *data* (the words it is about, plus notes, title, color,
 * highlights and links). Here that data becomes real footnotes: each quote is
 * found in the page's own text — the same characters the reader's text layer
 * shows — and the footnote is anchored there and tagged with its run, so the
 * whole run can be undone.
 */

import type { AnnotationJobItemDto, AnnotationJobReferenceDto, LcClient, NewAnnotationJobDto } from "../api/client";
import { excerptOf } from "./docAnchors";
import { addFootnote, freshFootnoteId, type DocFootnote } from "./docFootnotes";
import { applyFootnoteResult, linkAnswerWorkspaceItems, writeFootnotes } from "./footnoteRequests";
import { normalizePalette, paletteForMarkIndex } from "./inkPaletteHistory";
import { quoteFromStream } from "./quoteAnchor";
import { getAnnotateDoc } from "./annotateStore";
import { borrowPdfDocument } from "../modes/pdfOpenDocs";

const ACTIVE_KEY = "whiteboard.annotationJobs.v1";
const SUPPRESSED_KEY = "whiteboard.annotationJobSuppressions.v1";
const suppressedCache = new Map<string, { raw: string | null; ids: Set<string> }>();
const pendingUndos = new Map<string, Promise<void>>();

function suppressionKey(docId: string): string { return `${SUPPRESSED_KEY}.${encodeURIComponent(docId)}`; }
function undoKey(docId: string, jobId: string): string { return `${docId}\n${jobId}`; }

function suppressedJobIds(docId: string): Set<string> {
  let cached = suppressedCache.get(docId);
  try {
    const raw = localStorage.getItem(suppressionKey(docId));
    if (!cached || cached.raw !== raw) {
      let ids: unknown = [];
      try { ids = JSON.parse(raw ?? "[]"); } catch { /* unreadable storage has no saved runs */ }
      cached = { raw, ids: new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []) };
      suppressedCache.set(docId, cached);
    }
  } catch { /* keep the in-memory marker when browser storage is unavailable */ }
  return cached?.ids ?? new Set<string>();
}

function saveSuppressedJobs(docId: string, ids: Set<string>): void {
  const raw = JSON.stringify([...ids]);
  const cached = { raw: suppressedCache.get(docId)?.raw ?? null, ids };
  suppressedCache.set(docId, cached);
  try { localStorage.setItem(suppressionKey(docId), raw); cached.raw = raw; } catch { /* this session still suppresses delivery */ }
}

/** Stop a cancelled or undone run from placing answers already fetched by a poll. */
export function suppressAnnotationJob(docId: string, jobId: string): void {
  saveSuppressedJobs(docId, new Set([...suppressedJobIds(docId), jobId]));
}

function isSuppressed(docId: string, jobId: string): boolean { return suppressedJobIds(docId).has(jobId); }

export interface ActiveJob { id: string; docId: string }

/** Runs this device is still waiting on, so polling stops when none are. */
export function activeAnnotationJobs(): ActiveJob[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((job): job is ActiveJob => typeof job?.id === "string" && typeof job?.docId === "string")
      : [];
  } catch {
    return [];
  }
}

function saveActive(jobs: readonly ActiveJob[]): void {
  const unique = [...new Map(jobs.map((job) => [job.id, job])).values()].slice(-20);
  try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(unique)); } catch { /* polling just stops */ }
}

export function rememberAnnotationJob(id: string, docId: string): void {
  saveActive([...activeAnnotationJobs(), { id, docId }]);
}

export function forgetAnnotationJob(id: string): void {
  saveActive(activeAnnotationJobs().filter((entry) => entry.id !== id));
}

/** Event other views listen for after footnotes from a run were placed. */
export const ANNOTATION_JOBS_EVENT = "lc-annotation-jobs";

/**
 * One poll: place what has arrived, then forget runs that are finished and
 * fully delivered. Cheap when nothing is active.
 */
export async function pollAnnotationJobs(client: LcClient): Promise<void> {
  const active = activeAnnotationJobs();
  if (active.length === 0) return;
  const outcome = await placeAnnotationJobItems(client);
  if (outcome.placed > 0 || outcome.unplaced > 0) {
    window.dispatchEvent(new CustomEvent(ANNOTATION_JOBS_EVENT, { detail: outcome }));
  }
  if (outcome.waiting > 0) return;
  for (const docId of new Set(active.map((job) => job.docId))) {
    const jobs = await client.annotationJobs(docId).catch(() => null);
    if (!jobs) continue;
    for (const job of jobs) {
      if (job.status !== "open" && active.some((entry) => entry.id === job.id)) forgetAnnotationJob(job.id);
    }
  }
}

/**
 * Where `quote` sits in `text`, ignoring whitespace and case.
 *
 * The assistant reads extracted text, which puts spaces between the PDF's text
 * pieces; the page the reader sees joins the same pieces with none. Matching on
 * letters alone finds the passage either way, and the offsets returned are in
 * `text` itself.
 */
export function findLoosely(text: string, quote: string): { start: number; end: number } | null {
  const positions: number[] = [];
  let letters = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) continue;
    letters += ch.toLowerCase();
    positions.push(i);
  }
  const needle = quote.replace(/\s+/g, "").toLowerCase();
  if (!needle) return null;
  const at = letters.indexOf(needle);
  if (at < 0) return null;
  return { start: positions[at]!, end: positions[at + needle.length - 1]! + 1 };
}

/**
 * A page's characters exactly as its text layer renders them.
 *
 * pdf.js draws one span per text item and nothing between them, so the stream
 * an anchor indexes is the items' strings joined with no separator.
 */
export async function pdfPageStream(hash: string, page: number): Promise<string | null> {
  const pdf = borrowPdfDocument(hash);
  if (!pdf) return null;
  const content = await (await pdf.getPage(page)).getTextContent();
  return content.items.map((item) => ("str" in item ? String(item.str) : "")).join("");
}

/** Text of pages `from..=to` for the assistant to read, as extraction words it. */
export async function pdfPagesForJob(hash: string, from: number, to: number, maxPageChars = 12_000): Promise<{ pages: { page: number; scope: string; text: string }[]; skipped: number[] }> {
  const pdf = borrowPdfDocument(hash);
  if (!pdf) throw new Error("Open the PDF first; its pages are read from the open document.");
  const pages: { page: number; scope: string; text: string }[] = [];
  const skipped: number[] = [];
  for (let page = Math.max(1, from); page <= Math.min(to, pdf.numPages); page++) {
    const content = await (await pdf.getPage(page)).getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? String(item.str) : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    // A scanned page has no text layer: nothing to quote, so nothing to annotate.
    if (text) pages.push({ page, scope: `p${page}`, text: text.slice(0, maxPageChars) });
    else skipped.push(page);
  }
  return { pages, skipped };
}

/** Attachments share one limit, so a long file need not be cut into pieces. */
export const REFERENCES_TOTAL_CHARS = 600_000;

export type ChatBotAttachment =
  | { kind: "file"; docId: string; title: string }
  | { kind: "pages"; from: number; to: number; title?: string };

const attachmentsKey = (docId: string) => `whiteboard.chatBotPages.attachments.v2:${docId}`;
const oldReferencesKey = (docId: string) => `whiteboard.chatBotPages.refs.v1:${docId}`;

function savedAttachment(raw: unknown): ChatBotAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.kind === "file" && typeof value.docId === "string" && value.docId.trim()) {
    return { kind: "file", docId: value.docId, title: typeof value.title === "string" ? value.title : value.docId };
  }
  if (value.kind === "pages" && Number.isInteger(value.from) && Number.isInteger(value.to)
    && Number(value.from) > 0 && Number(value.to) >= Number(value.from)) {
    return {
      kind: "pages", from: Number(value.from), to: Number(value.to),
      ...(typeof value.title === "string" ? { title: value.title } : {}),
    };
  }
  return null;
}

/** Last attachments on this document, including the earlier problem/file picker. */
export function loadChatBotAttachments(docId: string): ChatBotAttachment[] {
  try {
    const saved = localStorage.getItem(attachmentsKey(docId));
    if (saved !== null) {
      const raw: unknown = JSON.parse(saved);
      return Array.isArray(raw) ? raw.flatMap((entry) => {
        const attachment = savedAttachment(entry);
        return attachment ? [attachment] : [];
      }) : [];
    }
    const old = JSON.parse(localStorage.getItem(oldReferencesKey(docId)) ?? "null");
    if (!old || typeof old !== "object") return [];
    const out: ChatBotAttachment[] = [];
    const from = typeof old.problemFrom === "string" ? Number(old.problemFrom.trim()) : 0;
    const to = typeof old.problemTo === "string" && old.problemTo.trim() ? Number(old.problemTo.trim()) : from;
    if (Number.isInteger(from) && Number.isInteger(to) && from > 0 && to >= from) {
      out.push({ kind: "pages", from, to });
    }
    if (Array.isArray(old.files)) {
      const files: unknown[] = old.files;
      for (const docId of new Set(files.filter((id): id is string => typeof id === "string" && id.trim().length > 0))) {
        out.push({ kind: "file", docId, title: docId });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function saveChatBotAttachments(docId: string, attachments: readonly ChatBotAttachment[]): void {
  try { localStorage.setItem(attachmentsKey(docId), JSON.stringify(attachments)); } catch { /* a convenience only */ }
}

/** Count the characters the hub counts, including letters outside the BMP. */
export function referenceChars(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++, count++) {
    const first = text.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
  }
  return count;
}

export function referencesSizeError(references: readonly AnnotationJobReferenceDto[]): string | null {
  const total = references.reduce((sum, reference) => sum + referenceChars(reference.text), 0);
  return total > REFERENCES_TOTAL_CHARS
    ? `Attachments contain ${total.toLocaleString()} characters. The limit is ${REFERENCES_TOTAL_CHARS.toLocaleString()}; remove an attachment or choose fewer pages.`
    : null;
}

export interface PreparedJobAttachment {
  attachment: ChatBotAttachment;
  reference: AnnotationJobReferenceDto | null;
  chars: number;
  error: string | null;
}

/** Keep one result per attachment, so a missing file cannot disappear from a run. */
export async function preparedJobAttachments(input: {
  hash: string;
  attachments: readonly ChatBotAttachment[];
}): Promise<PreparedJobAttachment[]> {
  return Promise.all(input.attachments.map(async (attachment) => {
    const title = attachment.kind === "file" ? attachment.title || attachment.docId : attachment.title
      ?? (attachment.from === attachment.to ? `Page ${attachment.from}` : `Pages ${attachment.from}–${attachment.to}`);
    try {
      let text: string;
      if (attachment.kind === "pages") {
        const { from, to } = attachment;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
          throw new Error(`Choose a valid page range for ${title}.`);
        }
        const pdf = borrowPdfDocument(input.hash);
        if (pdf && to > pdf.numPages) throw new Error(`${title} is outside this document's ${pdf.numPages} pages.`);
        // Job pages are shortened for quoting; attachments retain all their text.
        const { pages } = await pdfPagesForJob(input.hash, from, to, Infinity);
        text = pages.map((page) => `[Page ${page.page}]\n${page.text}`).join("\n\n");
      } else {
        const doc = await getAnnotateDoc(attachment.docId);
        if (!doc) throw new Error(`Couldn't read ${title}. Remove it or choose another file.`);
        text = doc.source?.trim() ?? "";
      }
      if (!text) throw new Error(`${title} has no text to attach.`);
      return { attachment, reference: { title, kind: attachment.kind, text }, chars: referenceChars(text), error: null };
    } catch (cause) {
      return { attachment, reference: null, chars: 0, error: cause instanceof Error ? cause.message : `Couldn't read ${title}.` };
    }
  }));
}

/** Read generic attachments and reject an unreadable or oversized set before sending. */
export async function jobReferences(input: {
  hash: string;
  attachments: readonly ChatBotAttachment[];
}): Promise<AnnotationJobReferenceDto[]> {
  const prepared = await preparedJobAttachments(input);
  const error = prepared.find((entry) => entry.error)?.error;
  if (error) throw new Error(error);
  const references = prepared.flatMap((entry) => entry.reference ? [entry.reference] : []);
  const sizeError = referencesSizeError(references);
  if (sizeError) throw new Error(sizeError);
  return references;
}

/** Same place on the page, whoever made it. */
function samePlace(a: DocFootnote, b: DocFootnote): boolean {
  const x = a.anchor, y = b.anchor;
  return x.kind === "text" && y.kind === "text" && x.start === y.start && x.end === y.end && (x.scope ?? "") === (y.scope ?? "");
}

/**
 * The footnote an item describes, placed on `stream` (one page's text).
 * Null when the quote is not on the page.
 */
export function footnoteFromItem(
  item: AnnotationJobItemDto,
  stream: string,
  existing: readonly DocFootnote[],
  now = Date.now(),
): DocFootnote | null {
  const at = findLoosely(stream, item.quote);
  if (!at) return null;
  const exact = stream.slice(at.start, at.end);
  const palette = normalizePalette(item.palette) ?? paletteForMarkIndex(existing.length);
  const pending = `job-item-${item.item_id}`;
  const base: DocFootnote = {
    id: freshFootnoteId(existing, now),
    kind: "ai",
    notes: [], threads: [], bands: [], subMarks: [], userLinks: [], whiteboards: [], artifacts: [],
    anchor: {
      kind: "text",
      start: at.start,
      end: at.end,
      scope: item.scope,
      ...(quoteFromStream(stream, at.start, at.end) ?? {}),
    },
    excerpt: excerptOf(exact),
    blockText: exact,
    createdAt: now,
    palette,
    jobId: item.job_id,
    pending,
  };
  const result = item.result;
  const [filled] = applyFootnoteResult([base], {
    id: pending,
    notes: result.notes,
    links: result.links ?? [],
    ...(result.title ? { title: result.title } : {}),
    ...(typeof result.color === "number" ? { color: result.color } : {}),
    marks: result.marks ?? [],
    fields: result.fields ?? [],
  }, now);
  return filled ?? null;
}

export interface PlaceOutcome {
  placed: number;
  /** Items whose quote is not on its page; acknowledged and reported, not guessed. */
  unplaced: number;
  /** Items left for later, because their document's PDF is not open here. */
  waiting: number;
}

/**
 * Fetch finished items for this device and place each on its page.
 *
 * Only documents whose PDF is open can be placed (their page text comes from
 * the open file); the rest stay on the hub until the document is opened.
 */
export async function placeAnnotationJobItems(client: LcClient): Promise<PlaceOutcome> {
  const outcome: PlaceOutcome = { placed: 0, unplaced: 0, waiting: 0 };
  const items = await client.annotationJobItems();
  if (items.length === 0) return outcome;
  const byDoc = new Map<string, AnnotationJobItemDto[]>();
  const suppressed: AnnotationJobItemDto[] = [];
  for (const item of items) {
    if (isSuppressed(item.doc_id, item.job_id)) suppressed.push(item);
    else byDoc.set(item.doc_id, [...(byDoc.get(item.doc_id) ?? []), item]);
  }
  const done: number[] = [];
  for (const [docId, docItems] of byDoc) {
    const doc = await getAnnotateDoc(docId).catch(() => null);
    if (!doc || doc.docType !== "pdf" || !borrowPdfDocument(doc.hash)) {
      for (const item of docItems) {
        if (isSuppressed(docId, item.job_id)) suppressed.push(item);
        else outcome.waiting += 1;
      }
      continue;
    }
    const streams = new Map<number, string | null>();
    for (const item of docItems) {
      if (!streams.has(item.page)) streams.set(item.page, await pdfPageStream(doc.hash, item.page).catch(() => null));
    }
    const placedItems: AnnotationJobItemDto[] = [];
    const write = await writeFootnotes(docId, (footnotes) => {
      let next = [...footnotes];
      placedItems.length = 0;
      for (const item of docItems) {
        // Undo may have finished while the poll was reading this PDF's text.
        if (isSuppressed(docId, item.job_id)) continue;
        const stream = streams.get(item.page);
        const footnote = stream ? footnoteFromItem(item, stream, next) : null;
        if (!footnote) continue;
        placedItems.push(item);
        // A retried delivery, or a mark the reader already has there: keep theirs.
        if (next.some((existing) => samePlace(existing, footnote))) continue;
        next = addFootnote(next, footnote);
      }
      return next.length === footnotes.length ? (footnotes as DocFootnote[]) : next;
    });
    const currentItems = docItems.filter((item) => {
      if (!isSuppressed(docId, item.job_id)) return true;
      suppressed.push(item);
      return false;
    });
    if (write === "failed") {
      outcome.waiting += currentItems.length;
      continue;
    }
    const currentPlaced = placedItems.filter((item) => !isSuppressed(docId, item.job_id));
    outcome.placed += currentPlaced.length;
    outcome.unplaced += currentItems.length - currentPlaced.length;
    for (const item of currentPlaced) {
      if (isSuppressed(docId, item.job_id)) continue;
      await linkAnswerWorkspaceItems(docId, item.result, item.doc_kind);
    }
    done.push(...currentItems.map((item) => item.item_id));
  }
  for (const item of suppressed) {
    // A failed Undo restores delivery; keep its queued items until the save ends.
    await pendingUndos.get(undoKey(item.doc_id, item.job_id));
    if (isSuppressed(item.doc_id, item.job_id)) done.push(item.item_id);
    else outcome.waiting += 1;
  }
  if (done.length) await client.ackAnnotationJobItems([...new Set(done)]);
  return outcome;
}

/** Remove every footnote a run created on this document, and nothing else. */
export async function undoAnnotationJob(docId: string, jobId: string): Promise<number> {
  let removed = 0;
  const wasSuppressed = isSuppressed(docId, jobId);
  suppressAnnotationJob(docId, jobId);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const key = undoKey(docId, jobId);
  pendingUndos.set(key, pending);
  try {
    const write = await writeFootnotes(docId, (footnotes) => {
      const kept = footnotes.filter((footnote) => footnote.jobId !== jobId);
      removed = footnotes.length - kept.length;
      return removed ? kept : (footnotes as DocFootnote[]);
    });
    if (write === "failed") throw new Error("Couldn't save the document after undoing this run.");
    return removed;
  } catch (cause) {
    if (!wasSuppressed) {
      const restored = new Set(suppressedJobIds(docId));
      restored.delete(jobId);
      saveSuppressedJobs(docId, restored);
    }
    throw cause;
  } finally {
    finish();
    if (pendingUndos.get(key) === pending) pendingUndos.delete(key);
  }
}

export type { NewAnnotationJobDto };
