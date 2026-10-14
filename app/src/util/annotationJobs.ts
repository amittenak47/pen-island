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

import type { AnnotationJobItemDto, LcClient, NewAnnotationJobDto } from "../api/client";
import { excerptOf } from "./docAnchors";
import { addFootnote, freshFootnoteId, type DocFootnote } from "./docFootnotes";
import { applyFootnoteResult, linkAnswerWorkspaceItems, writeFootnotes } from "./footnoteRequests";
import { normalizePalette, paletteForMarkIndex } from "./inkPaletteHistory";
import { quoteFromStream } from "./quoteAnchor";
import { getAnnotateDoc } from "./annotateStore";
import { borrowPdfDocument } from "../modes/pdfOpenDocs";

const ACTIVE_KEY = "whiteboard.annotationJobs.v1";

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
export async function pdfPagesForJob(hash: string, from: number, to: number): Promise<{ pages: { page: number; scope: string; text: string }[]; skipped: number[] }> {
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
    if (text) pages.push({ page, scope: `p${page}`, text: text.slice(0, 12_000) });
    else skipped.push(page);
  }
  return { pages, skipped };
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
  for (const item of items) byDoc.set(item.doc_id, [...(byDoc.get(item.doc_id) ?? []), item]);
  const done: number[] = [];
  for (const [docId, docItems] of byDoc) {
    const doc = await getAnnotateDoc(docId).catch(() => null);
    if (!doc || doc.docType !== "pdf" || !borrowPdfDocument(doc.hash)) {
      outcome.waiting += docItems.length;
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
    if (write === "failed") {
      outcome.waiting += docItems.length;
      continue;
    }
    outcome.placed += placedItems.length;
    outcome.unplaced += docItems.length - placedItems.length;
    for (const item of placedItems) {
      await linkAnswerWorkspaceItems(docId, item.result, item.doc_kind);
    }
    done.push(...docItems.map((item) => item.item_id));
  }
  if (done.length) await client.ackAnnotationJobItems(done);
  return outcome;
}

/** Remove every footnote a run created on this document, and nothing else. */
export async function undoAnnotationJob(docId: string, jobId: string): Promise<number> {
  let removed = 0;
  await writeFootnotes(docId, (footnotes) => {
    const kept = footnotes.filter((footnote) => footnote.jobId !== jobId);
    removed = footnotes.length - kept.length;
    return removed ? kept : (footnotes as DocFootnote[]);
  });
  return removed;
}

export type { NewAnnotationJobDto };
