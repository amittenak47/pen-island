/** The ChatBot sheet shares Settings' blocks and keeps run details one tap away. */
import { useCallback, useEffect, useState } from "react";
import type { AnnotationJobDto, AnnotationJobReferenceDto, AssistantRunnerStatus, FootnoteWorkspaceItemDto, LcClient } from "../api/client";
import type { DocSelectionResult } from "./DocSelectionLayer";
import { DialogFrame } from "../components/DialogFrame";
import { SettingsChoices } from "../components/SettingsChoices";
import {
  ANNOTATION_JOBS_EVENT, forgetAnnotationJob, loadChatBotAttachments, pdfPagesForJob,
  preparedJobAttachments, referencesSizeError, REFERENCES_TOTAL_CHARS, rememberAnnotationJob,
  saveChatBotAttachments, suppressAnnotationJob, undoAnnotationJob, type ChatBotAttachment, type PreparedJobAttachment,
} from "../util/annotationJobs";
import { getAnnotateDocMeta } from "../util/annotateStore";
import { loadDeviceId } from "../util/devicePrefs";
import { assistantRunnerMessage, loadChatBotAnswerMode } from "../util/chatBotClient";
import type { DocFootnote } from "../util/docFootnotes";
import { loadSelectionRuns, rememberSelectionRun, updateSelectionRun, type ChatBotRun } from "../util/chatBotHistory";
import "../components/settingsDialog.css";
import "./chatBotPages.css";

const DENSITY = [{ perPage: 2, label: "Light" }, { perPage: 4, label: "Normal" }, { perPage: 8, label: "Thorough" }] as const;
export const MAX_JOB_PAGES = 40;
type RequestType = "selection" | "page" | "pages";
export interface SelectionRequestSettings { focus: string; perPage: number; references: AnnotationJobReferenceDto[] }
export interface ChatBotPagesDialogProps {
  client: LcClient;
  docId: string;
  docName: string;
  hash: string;
  currentPage: number;
  pageCount: number;
  palette: readonly string[];
  workspaceItems: readonly FootnoteWorkspaceItemDto[];
  selection?: DocSelectionResult | null;
  footnotes?: readonly DocFootnote[];
  onSelectionRequest?: (settings: SelectionRequestSettings) => Promise<{ id: string; page: number }>;
  onCancelSelectionRequest?: (id: string) => Promise<void>;
  onJumpToPage?: (page: number) => void;
  onClose: () => void;
}
function pageLabel(from: number, to: number): string { return from === to ? `Page ${from}` : `Pages ${from}–${to}`; }
function requestLabel(job: ChatBotRun): string {
  return job.request_type === "selection" ? "Selection" : job.request_type === "page" ? "This page" : "Pages";
}
function statusLabel(job: ChatBotRun): string { return job.status === "open" ? "In progress" : job.status === "done" ? "Finished" : "Cancelled"; }
function runLabel(job: ChatBotRun, status = statusLabel(job)): string {
  return `${requestLabel(job)} · ${pageLabel(job.page_from, job.page_to)} · ${job.footnotes} footnote${job.footnotes === 1 ? "" : "s"} · ${status}`;
}
function rangeError(from: number, to: number, pageCount: number, limit = MAX_JOB_PAGES): string | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return "Choose a valid page range.";
  if (pageCount > 0 && to > pageCount) return `This document has ${pageCount} pages.`;
  return to - from + 1 > limit ? `Up to ${limit} pages at a time.` : null;
}
function sizeLabel(chars: number): string { return `${chars.toLocaleString()} characters`; }
const CHATBOT_ICON = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
  <path d="M12 8.2l.9 1.9 1.9.9-1.9.9-.9 1.9-.9-1.9-1.9-.9 1.9-.9z" fill="currentColor" stroke="none" />
</svg>;

export function ChatBotPagesDialog({
  client, docId, docName, hash, currentPage, pageCount, palette, workspaceItems,
  selection, footnotes = [], onSelectionRequest, onCancelSelectionRequest, onJumpToPage, onClose,
}: ChatBotPagesDialogProps) {
  const hasSelection = Boolean(selection?.text.trim() && onSelectionRequest);
  const [request, setRequest] = useState<RequestType>(hasSelection ? "selection" : "page");
  const [from, setFrom] = useState(Math.max(1, currentPage));
  const [to, setTo] = useState(Math.min(pageCount || currentPage, Math.max(1, currentPage) + 9));
  const [focus, setFocus] = useState("");
  const [perPage, setPerPage] = useState(4);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [jobs, setJobs] = useState<AnnotationJobDto[]>([]);
  const [runnerStatus, setRunnerStatus] = useState<AssistantRunnerStatus | null>(null);
  const answerMode = loadChatBotAnswerMode();
  const [selectionRuns, setSelectionRuns] = useState(() => loadSelectionRuns(docId));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ChatBotAttachment[]>(() => loadChatBotAttachments(docId).map((attachment) => {
    if (attachment.kind !== "file") return attachment;
    const title = workspaceItems.find((item) => item.id === `annotate:${attachment.docId}`)?.title;
    return title ? { ...attachment, title } : attachment;
  }));
  const [prepared, setPrepared] = useState<PreparedJobAttachment[] | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachFrom, setAttachFrom] = useState(currentPage);
  const [attachTo, setAttachTo] = useState(currentPage);
  const files = workspaceItems.flatMap((item) => {
    if (item.kind !== "annotate" || !item.id.startsWith("annotate:")) return [];
    const id = item.id.slice("annotate:".length);
    const kind = getAnnotateDocMeta(id)?.docType;
    return id !== docId && (kind === "markdown" || kind === "code") ? [{ docId: id, title: item.title }] : [];
  });
  const refresh = useCallback(async () => {
    try { setJobs(await client.annotationJobs(docId)); }
    catch { /* Keep visible history during a brief disconnect. */ }
    try { setRunnerStatus(await client.assistantRunnerStatus()); }
    catch { /* Older hubs and a brief disconnect keep the ordinary run status. */ }
  }, [client, docId]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener(ANNOTATION_JOBS_EVENT, refresh);
    return () => { window.clearInterval(timer); window.removeEventListener(ANNOTATION_JOBS_EVENT, refresh); };
  }, [refresh]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (activeId) setActiveId(null);
      else if (attachOpen) setAttachOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, attachOpen, onClose]);
  useEffect(() => {
    let current = true;
    setPrepared(null); setAttachmentError(null);
    saveChatBotAttachments(docId, attachments);
    void preparedJobAttachments({ hash, attachments }).then((result) => {
      if (!current) return;
      setPrepared(result);
      setAttachmentError(result.find((entry) => entry.error)?.error ?? referencesSizeError(result.flatMap((entry) => entry.reference ? [entry.reference] : [])));
    }).catch((cause) => {
      if (current) setAttachmentError(cause instanceof Error ? cause.message : "Couldn't read the attachments.");
    });
    return () => { current = false; };
  }, [docId, hash, attachments]);
  const selectedRequest = request === "selection" && !hasSelection ? "page" : request;
  const inputError = selectedRequest === "pages" ? rangeError(from, to, pageCount) : null;
  const attachedRangeError = rangeError(attachFrom, attachTo, pageCount, Infinity);
  const runs: ChatBotRun[] = [...jobs, ...selectionRuns.map((run) => {
    const marks = footnotes.filter((mark) => mark.jobId === run.id);
    const pending = marks.some((mark) => mark.pending);
    return { ...run, footnotes: marks.length, pages_done: pending ? 0 : 1,
      status: run.status === "cancelled" ? "cancelled" as const : pending ? "open" as const : "done" as const };
  })].sort((a, b) => b.created_at - a.created_at);
  const active = runs.find((run) => run.id === activeId);
  const pages = new Map<number, string[]>();
  for (const mark of footnotes) {
    if (mark.jobId !== activeId) continue;
    const page = Number(mark.anchor.scope?.match(/^p(\d+)r?$/)?.[1]);
    if (!page) continue;
    pages.set(page, [...(pages.get(page) ?? []), mark.title?.trim() || mark.excerpt.slice(0, 70) || "Footnote"]);
  }
  const start = async () => {
    if (inputError || attachmentError || prepared === null || busy) return;
    setBusy(true); setMessage(null);
    try {
      const references = prepared.flatMap((entry) => entry.reference ? [entry.reference] : []);
      if (selectedRequest === "selection" && onSelectionRequest) {
        const sent = await onSelectionRequest({ focus: focus.trim(), perPage, references });
        rememberSelectionRun(docId, { id: sent.id, doc_id: docId, doc_name: docName, request_type: "selection",
          answer_mode: answerMode,
          page_from: sent.page, page_to: sent.page, focus: focus.trim(), per_page: perPage,
          pages_total: 1, pages_done: 0, footnotes: 1, status: "open", created_at: Date.now(),
          references: references.map(({ title, kind }) => ({ title, kind })) });
        setSelectionRuns(loadSelectionRuns(docId)); setMessage("Selection sent to ChatBot.");
      } else {
        const { pages: requestedPages, skipped } = await pdfPagesForJob(hash,
          selectedRequest === "page" ? currentPage : from, selectedRequest === "page" ? currentPage : to);
        if (!requestedPages.length) { setMessage("These pages have no readable text."); return; }
        const id = `aj-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        await client.createAnnotationJob({ id, device_id: loadDeviceId(), doc_id: docId, doc_name: docName,
          doc_kind: "annotate", request_type: selectedRequest === "page" ? "page" : "pages", answer_mode: answerMode, focus: focus.trim(), per_page: perPage,
          pages: requestedPages, palette: [...palette], workspace_items: [...workspaceItems], references });
        rememberAnnotationJob(id, docId);
        setMessage(`Sent to ChatBot.${skipped.length ? ` Skipped ${skipped.length} page${skipped.length === 1 ? "" : "s"} without text.` : ""}`);
        await refresh();
      }
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Couldn't send. Check the connection to your PC."); }
    finally { setBusy(false); }
  };
  const cancelRun = async (run: ChatBotRun) => {
    if (run.request_type === "selection") {
      if (!onCancelSelectionRequest) throw new Error("Selection cancellation unavailable");
      await onCancelSelectionRequest(run.id);
      updateSelectionRun(docId, run.id, { status: "cancelled" });
      setSelectionRuns(loadSelectionRuns(docId));
    } else {
      await client.cancelAnnotationJob(run.id);
      suppressAnnotationJob(docId, run.id);
      forgetAnnotationJob(run.id);
      await refresh();
    }
  };
  const cancel = async (run: ChatBotRun) => {
    setBusy(true); setMessage(null);
    try { await cancelRun(run); }
    catch { setMessage("Couldn't cancel. Check the connection to your PC."); }
    finally { setBusy(false); }
  };
  const undo = async (run: ChatBotRun) => {
    setBusy(true); setMessage(null);
    try {
      // Stop incoming answers before removing their marks.
      if (run.status === "open") await cancelRun(run);
      const removed = await undoAnnotationJob(docId, run.id);
      setMessage(`Removed ${removed} footnote${removed === 1 ? "" : "s"}.`);
      await refresh();
    } catch { setMessage("Couldn't undo this run."); }
    finally { setBusy(false); }
  };
  const statusFor = (run: ChatBotRun) => {
    const matches = runnerStatus?.job_id === run.id || (run.request_type === "selection" && !runnerStatus?.job_id);
    if (run.status !== "open" || run.answer_mode !== "app" || !runnerStatus || !matches) return statusLabel(run);
    if (runnerStatus.state === "failed" && (!runnerStatus.started_at || runnerStatus.started_at < run.created_at)) return statusLabel(run);
    return runnerStatus.state === "running" || runnerStatus.state === "failed" ? assistantRunnerMessage(runnerStatus) : statusLabel(run);
  };
  return (
    <div className="lc-chatbot-pages-scrim" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <DialogFrame className="lc-settings-dialog lc-chatbot-pages" titleId="lc-chatbot-dialog-title" title="ChatBot" subtitle="" icon={CHATBOT_ICON}
        shape="blocky" ariaLabel="ChatBot" onClose={onClose}>
        <div className="lc-settings-body lc-dialog-body lc-scroll-pane">
          <section className="lc-settings-fold"><div className="lc-settings-fold-body lc-settings-fields">
            <div className="lc-settings-subhead">Request</div>
            <SettingsChoices className="lc-settings-choice" role="radiogroup" aria-label="Request type">
              {(hasSelection ? ["selection", "page", "pages"] as const : ["page", "pages"] as const).map((kind) => <button key={kind} type="button" role="radio" aria-checked={selectedRequest === kind}
                className={`lc-settings-choice-option${selectedRequest === kind ? " is-active" : ""}`} onClick={() => setRequest(kind)}>{kind === "selection" ? "Selection" : kind === "page" ? "This page" : "Pages"}</button>)}
            </SettingsChoices>
            {selectedRequest === "pages" ? <div className="lc-chatbot-page-range">
              <label>From page<input type="number" min={1} max={pageCount || undefined} value={from || ""} onChange={(event) => setFrom(Number(event.target.value))} /></label>
              <label>To page<input type="number" min={1} max={pageCount || undefined} value={to || ""} onChange={(event) => setTo(Number(event.target.value))} /></label>
            </div> : <p className="lc-settings-hint">{selectedRequest === "selection" ? selection?.text.slice(0, 160) : pageLabel(currentPage, currentPage)}</p>}
            {inputError ? <p className="lc-chatbot-pages-error" role="alert">{inputError}</p> : null}
            <label>Focus (optional)<textarea rows={2} maxLength={1000} value={focus} onChange={(event) => setFocus(event.target.value)} placeholder="For example: key definitions and proofs" /></label>
            <div className="lc-settings-subhead">How much</div>
            <SettingsChoices className="lc-settings-choice" role="radiogroup" aria-label="How many footnotes">
              {DENSITY.map((option) => <button key={option.perPage} type="button" role="radio" aria-checked={perPage === option.perPage}
                className={`lc-settings-choice-option${perPage === option.perPage ? " is-active" : ""}`} onClick={() => setPerPage(option.perPage)}>{option.label}</button>)}
            </SettingsChoices>
          </div></section>
          <section className="lc-settings-fold"><div className="lc-settings-fold-body lc-settings-fields">
            <div className="lc-settings-actions-row"><button type="button" className="lc-secondary lc-dialog-action" aria-expanded={attachOpen} onClick={() => setAttachOpen(!attachOpen)}>Attach</button></div>
            {attachments.length ? <ul className="lc-chatbot-attachments" aria-label="Attachments">{attachments.map((attachment, index) => <li key={attachment.kind === "file" ? attachment.docId : `${attachment.from}-${attachment.to}`}>
              <div><strong>{attachment.title || (attachment.kind === "pages" ? pageLabel(attachment.from, attachment.to) : attachment.docId)}</strong><small>{prepared?.[index] ? prepared[index]!.error ?? sizeLabel(prepared[index]!.chars) : "Reading…"}</small></div>
              <button type="button" className="lc-dialog-action" aria-label={`Remove attachment ${index + 1}`} onClick={() => setAttachments(attachments.filter((_, at) => at !== index))}>Remove</button>
            </li>)}</ul> : null}
            {attachOpen ? <>
              {files.length ? <SettingsChoices className="lc-settings-choice" aria-label="Library files">{files.map((file) => {
                const picked = attachments.some((attachment) => attachment.kind === "file" && attachment.docId === file.docId);
                return <button key={file.docId} type="button" className={`lc-settings-choice-option${picked ? " is-active" : ""}`} aria-pressed={picked}
                  onClick={() => setAttachments(picked ? attachments.filter((entry) => entry.kind !== "file" || entry.docId !== file.docId) : [...attachments, { kind: "file", ...file }])}>{file.title}</button>;
              })}</SettingsChoices> : <p className="lc-settings-hint">No library files to attach.</p>}
              <div className="lc-settings-subhead">PDF pages</div>
              <div className="lc-chatbot-page-range"><label>Attach from page<input type="number" min={1} max={pageCount || undefined} value={attachFrom || ""} onChange={(event) => setAttachFrom(Number(event.target.value))} /></label>
                <label>Attach to page<input type="number" min={1} max={pageCount || undefined} value={attachTo || ""} onChange={(event) => setAttachTo(Number(event.target.value))} /></label></div>
              {attachedRangeError ? <p className="lc-chatbot-pages-error">{attachedRangeError}</p> : null}
              <div className="lc-settings-actions-row"><button type="button" className="lc-secondary lc-dialog-action" disabled={Boolean(attachedRangeError)} onClick={() => {
                if (!attachments.some((entry) => entry.kind === "pages" && entry.from === attachFrom && entry.to === attachTo)) setAttachments([...attachments, { kind: "pages", from: attachFrom, to: attachTo, title: pageLabel(attachFrom, attachTo) }]);
                setAttachOpen(false);
              }}>Attach pages</button></div>
            </> : null}
            {attachments.length ? <p className="lc-settings-hint">{prepared ? sizeLabel(prepared.reduce((total, entry) => total + entry.chars, 0)) : "Reading attachments…"} / {REFERENCES_TOTAL_CHARS.toLocaleString()} total</p> : null}
            {attachmentError ? <p className="lc-chatbot-pages-error" role="alert">{attachmentError}</p> : null}
          </div></section>
          <p className="lc-settings-hint">{answerMode === "app" ? "Your PC starts the assistant automatically. Footnotes appear as it works."
            : answerMode === "llm" && selectedRequest !== "selection" ? "Your AI model answers single footnotes; page runs need an assistant."
              : "Ask your assistant to answer your requests. Footnotes appear as it works."}</p>
          <div className="lc-settings-actions-row"><button type="button" className="lc-primary lc-dialog-action" disabled={Boolean(inputError || attachmentError) || prepared === null || busy} onClick={() => void start()}>{busy ? "Sending…" : "Start"}</button></div>
          {message && !active ? <p className="lc-settings-hint" role="status">{message}</p> : null}
          {runs.length ? <section className="lc-settings-fold" aria-label="History"><div className="lc-settings-fold-body lc-settings-fields"><div className="lc-settings-subhead">History</div>
            <div className="lc-settings-choice">{runs.map((run) => <button key={run.id} type="button" className="lc-settings-choice-option lc-chatbot-history-row" onClick={() => setActiveId(run.id)}>{runLabel(run, statusFor(run))}</button>)}</div>
          </div></section> : null}
        </div>
      </DialogFrame>
      {active ? <div className="lc-chatbot-run-scrim" onClick={(event) => { if (event.target === event.currentTarget) setActiveId(null); }}>
          <DialogFrame className="lc-settings-dialog lc-chatbot-run-popup" titleId="lc-chatbot-run-title" title={requestLabel(active)} subtitle="" icon={CHATBOT_ICON}
            shape="blocky" ariaLabel="Run details" onClose={() => setActiveId(null)}>
            <div className="lc-settings-body lc-dialog-body lc-scroll-pane">
              <p className="lc-settings-hint">{pageLabel(active.page_from, active.page_to)} · {DENSITY.find((entry) => entry.perPage === active.per_page)?.label ?? active.per_page} · {statusFor(active)}</p>
              <p className="lc-settings-hint">Focus: {active.focus || "None"}</p>
              {active.references?.length ? <><div className="lc-settings-subhead">Attachments</div><ul className="lc-chatbot-run-list">{active.references.map((reference, index) => <li key={index}>{reference.title}</li>)}</ul></> : null}
              {active.summary ? <p className="lc-settings-hint">{active.summary}</p> : null}
              <div className="lc-settings-subhead">Footnotes</div>
              {pages.size ? <div className="lc-settings-choice">{[...pages].sort(([a], [b]) => a - b).map(([page, titles]) => <button key={page} type="button" className="lc-settings-choice-option" onClick={() => { onJumpToPage?.(page); onClose(); }}><strong>Page {page}</strong><span>{titles.join(" · ")}</span></button>)}</div> : <p className="lc-settings-hint">No footnotes on this device yet.</p>}
              <div className="lc-settings-actions-row">{active.status === "open" ? <button type="button" className="lc-secondary lc-dialog-action" disabled={busy} onClick={() => void cancel(active)}>Cancel</button> : null}
                {active.footnotes > 0 ? <button type="button" className="lc-secondary lc-dialog-action" disabled={busy} onClick={() => void undo(active)}>Undo</button> : null}</div>
              {message ? <p className="lc-settings-hint" role="status">{message}</p> : null}
            </div>
          </DialogFrame>
        </div> : null}
    </div>
  );
}
