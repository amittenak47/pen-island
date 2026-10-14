/**
 * The ChatBot page-range sheet, opened from the board's right tray.
 *
 * The reader picks pages (a chapter), an optional focus and how many footnotes
 * a page may get. The pages' text goes to the hub as a job; an assistant reads
 * it and sends back footnote data, which arrives on the pages as it is written.
 * Each run can be cancelled while it is going, or undone afterwards.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { AnnotationJobDto, FootnoteWorkspaceItemDto, LcClient } from "../api/client";
import {
  ANNOTATION_JOBS_EVENT,
  forgetAnnotationJob,
  pdfPagesForJob,
  rememberAnnotationJob,
  undoAnnotationJob,
} from "../util/annotationJobs";
import { loadDeviceId } from "../util/devicePrefs";
import "./chatBotPages.css";

const DENSITY = [
  { perPage: 2, label: "Light", hint: "About 2 footnotes a page" },
  { perPage: 4, label: "Normal", hint: "About 4 a page" },
  { perPage: 8, label: "Thorough", hint: "Up to 8 a page" },
] as const;

export const MAX_JOB_PAGES = 40;

export interface ChatBotPagesDialogProps {
  client: LcClient;
  docId: string;
  docName: string;
  hash: string;
  currentPage: number;
  pageCount: number;
  palette: readonly string[];
  workspaceItems: readonly FootnoteWorkspaceItemDto[];
  onClose: () => void;
}

function runLabel(job: AnnotationJobDto): string {
  const pages = job.page_from === job.page_to ? `Page ${job.page_from}` : `Pages ${job.page_from}–${job.page_to}`;
  const footnotes = `${job.footnotes} footnote${job.footnotes === 1 ? "" : "s"}`;
  const state = job.status === "open"
    ? `${job.pages_done} of ${job.pages_total} pages done`
    : job.status === "done" ? "Finished" : "Cancelled";
  return `${pages} · ${footnotes} · ${state}`;
}

export function ChatBotPagesDialog({
  client, docId, docName, hash, currentPage, pageCount, palette, workspaceItems, onClose,
}: ChatBotPagesDialogProps) {
  const [from, setFrom] = useState(Math.max(1, currentPage));
  const [to, setTo] = useState(Math.min(pageCount || currentPage, Math.max(1, currentPage) + 9));
  const [focus, setFocus] = useState("");
  const [perPage, setPerPage] = useState<number>(4);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [jobs, setJobs] = useState<AnnotationJobDto[]>([]);
  const firstRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setJobs(await client.annotationJobs(docId).catch(() => []));
  }, [client, docId]);

  useEffect(() => {
    firstRef.current?.focus();
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const onPlaced = () => void refresh();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener(ANNOTATION_JOBS_EVENT, onPlaced);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(ANNOTATION_JOBS_EVENT, onPlaced);
      window.removeEventListener("keydown", onKey);
    };
  }, [refresh, onClose]);

  const count = to - from + 1;
  const rangeError = !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from
    ? "Choose a first page and a last page after it."
    : pageCount > 0 && to > pageCount
      ? `This document has ${pageCount} pages.`
      : count > MAX_JOB_PAGES
        ? `Up to ${MAX_JOB_PAGES} pages at a time.`
        : null;

  const start = async () => {
    if (rangeError || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const { pages, skipped } = await pdfPagesForJob(hash, from, to);
      if (pages.length === 0) {
        setMessage("These pages have no text to read. Scanned pages can't be annotated yet.");
        return;
      }
      const id = `aj-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await client.createAnnotationJob({
        id,
        device_id: loadDeviceId(),
        doc_id: docId,
        doc_name: docName,
        doc_kind: "annotate",
        focus: focus.trim(),
        per_page: perPage,
        pages,
        palette: [...palette],
        workspace_items: [...workspaceItems],
      });
      rememberAnnotationJob(id, docId);
      setMessage(
        `Sent ${pages.length} page${pages.length === 1 ? "" : "s"} to ChatBot.` +
        (skipped.length ? ` Skipped ${skipped.length} without text (${skipped.slice(0, 6).join(", ")}${skipped.length > 6 ? "…" : ""}).` : "") +
        " Now ask your assistant to answer your annotation jobs.",
      );
      await refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Couldn't send these pages. Check the connection to your PC.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (job: AnnotationJobDto) => {
    await client.cancelAnnotationJob(job.id).catch(() => {});
    forgetAnnotationJob(job.id);
    await refresh();
  };

  const undo = async (job: AnnotationJobDto) => {
    const removed = await undoAnnotationJob(docId, job.id);
    setMessage(`Removed ${removed} footnote${removed === 1 ? "" : "s"} from ${runLabel(job).split(" · ")[0]!.toLowerCase()}.`);
  };

  return (
    <div className="lc-chatbot-pages-scrim" role="presentation" onClick={onClose}>
      <div className="lc-chatbot-pages" role="dialog" aria-modal="true" aria-label="Annotate pages with ChatBot"
        onClick={(event) => event.stopPropagation()}>
        <header className="lc-chatbot-pages-head">
          <h2>Annotate pages with ChatBot</h2>
          <button type="button" className="lc-chatbot-pages-close" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        <p className="lc-chatbot-pages-hint">
          ChatBot reads these pages and adds footnotes to the passages worth explaining, with
          highlights, notes and links. You can undo a run afterwards.
        </p>

        <div className="lc-chatbot-pages-row">
          <label>
            <span>From page</span>
            <input ref={firstRef} type="number" inputMode="numeric" min={1} max={pageCount || undefined}
              value={Number.isFinite(from) ? from : ""} onChange={(event) => setFrom(Number(event.target.value))} />
          </label>
          <label>
            <span>To page</span>
            <input type="number" inputMode="numeric" min={1} max={pageCount || undefined}
              value={Number.isFinite(to) ? to : ""} onChange={(event) => setTo(Number(event.target.value))} />
          </label>
        </div>
        {rangeError ? <p className="lc-chatbot-pages-error">{rangeError}</p> : null}

        <label className="lc-chatbot-pages-field">
          <span>Focus (optional)</span>
          <textarea rows={2} maxLength={1000} value={focus} onChange={(event) => setFocus(event.target.value)}
            placeholder="For example: key definitions and proofs, explained for a first-year student" />
        </label>

        <div className="lc-chatbot-pages-field">
          <span>How much</span>
          <div className="lc-chatbot-pages-density" role="radiogroup" aria-label="How many footnotes">
            {DENSITY.map((option) => (
              <button key={option.perPage} type="button" role="radio" aria-checked={perPage === option.perPage}
                className={perPage === option.perPage ? "is-active" : ""} onClick={() => setPerPage(option.perPage)}>
                <strong>{option.label}</strong>
                <small>{option.hint}</small>
              </button>
            ))}
          </div>
        </div>

        <p className="lc-chatbot-pages-hint">
          An assistant app does the reading. After you start, ask it to “answer my annotation jobs”
          (or pick “Keep answering footnote requests”). Footnotes appear here as it works; keep this
          document open on this device.
        </p>

        <div className="lc-chatbot-pages-actions">
          <button type="button" className="lc-secondary" onClick={onClose}>Close</button>
          <button type="button" className="lc-primary" disabled={Boolean(rangeError) || busy} onClick={() => void start()}>
            {busy ? "Sending…" : `Start (${Math.max(0, count)} page${count === 1 ? "" : "s"})`}
          </button>
        </div>
        {message ? <p className="lc-chatbot-pages-message" role="status">{message}</p> : null}

        {jobs.length > 0 ? (
          <section className="lc-chatbot-pages-runs" aria-label="Runs on this document">
            <h3>Runs on this document</h3>
            <ul>
              {jobs.map((job) => (
                <li key={job.id}>
                  <div>
                    <strong>{runLabel(job)}</strong>
                    {job.focus ? <small>Focus: {job.focus}</small> : null}
                    {job.summary ? <small>{job.summary}</small> : null}
                  </div>
                  <div className="lc-chatbot-pages-run-actions">
                    {job.status === "open" ? (
                      <button type="button" className="lc-secondary" onClick={() => void cancel(job)}>Cancel</button>
                    ) : null}
                    {job.footnotes > 0 ? (
                      <button type="button" className="lc-secondary" onClick={() => void undo(job)}>Undo</button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
