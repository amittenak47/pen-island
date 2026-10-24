/** The ChatBot sheet walks Request, Reading, Attach and Review; run details stay one tap away. */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { AnnotationJobDto, AnnotationJobReferenceDto, AssistantRunnerStatus, FootnoteWorkspaceItemDto, LcClient, ReadingStyleDto } from "../api/client";
import type { DocSelectionResult } from "./DocSelectionLayer";
import { DialogFrame } from "../components/DialogFrame";
import { SettingsChoices } from "../components/SettingsChoices";
import { AnimatedDisclosure } from "../components/AnimatedDisclosure";
import { ChoicePicker } from "../components/ChoiceSelect";
import { SlidingSegmented } from "../components/SlidingSegmented";
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
import {
  MAX_NOTE_FIELDS, PRESETS, READING_KINDS, choiceFields, fieldsFor, loadReadingChoice, readingStyleOf, saveReadingChoice,
  type ReadingChoice, type ReadingKind,
} from "../util/readingStyles";
import "../components/settingsDialog.css";
import "./chatBotPages.css";

const DENSITY = [{ perPage: 2, label: "Light" }, { perPage: 4, label: "Normal" }, { perPage: 8, label: "Thorough" }] as const;
export const MAX_JOB_PAGES = 40;
type RequestType = "selection" | "page" | "pages";
export interface SelectionRequestSettings { focus: string; perPage: number; references: AnnotationJobReferenceDto[]; reading?: ReadingStyleDto | null }
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
  // A page range already says "Pages", so only a page or a selection needs the prefix.
  const where = job.request_type === "pages" ? pageLabel(job.page_from, job.page_to) : `${requestLabel(job)} · ${pageLabel(job.page_from, job.page_to)}`;
  return `${where} · ${job.footnotes} footnote${job.footnotes === 1 ? "" : "s"} · ${status}`;
}
function readingLabel(job: ChatBotRun): string {
  const style = job.reading;
  const kind = READING_KINDS.find((entry) => entry.kind === style?.kind)?.label;
  if (!kind) return "Reading style not recorded";
  return `${kind} · ${style?.fields?.length ? style.preset?.trim() || "Custom" : "Free-form"}`;
}
function rangeError(from: number, to: number, pageCount: number, limit = MAX_JOB_PAGES): string | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return "Choose a valid page range.";
  if (pageCount > 0 && to > pageCount) return `This document has ${pageCount} pages.`;
  return to - from + 1 > limit ? `Up to ${limit} pages at a time.` : null;
}
function sizeLabel(chars: number): string { return `${chars.toLocaleString()} characters`; }
const STEPS = ["Request", "Reading", "Attach", "Review"] as const;
const REVIEW = STEPS.length - 1;
function listOf(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
/** The Review step's plain-language recap of what the request will ask for. */
function reviewSentence({ request, pagesText, focus, perPage, kindLabel, free, fields, fill, attached }: {
  request: RequestType; pagesText: string; focus: string; perPage: number; kindLabel?: string; free: boolean;
  fields: readonly string[]; fill: "best" | "all"; attached: readonly string[];
}): string {
  const parts = [`Your assistant will annotate ${request === "selection" ? "your selected text" : pagesText.replace(/^Page/, "page")}${focus ? `, focusing on ${focus}` : ""}.`];
  if (request !== "selection") parts.push(`The bot will limit notes to ${perPage} per page.`);
  if (kindLabel) {
    const kind = kindLabel.toLowerCase();
    const article = /^[aeiou]/.test(kind) ? "an" : "a";
    parts.push(free || !fields.length
      ? `It will read the text as ${article} ${kind} and choose which fields fit each passage.`
      : `It will read the text as ${article} ${kind} and try to fill in the ${listOf(fields)} fields${fill === "all" ? " for every passage" : " it has something worthwhile to say about"}.`);
  }
  if (attached.length) parts.push(`It will use ${listOf(attached)} as context.`);
  return parts.join(" ");
}
/** The last non-empty value, so an exiting reveal keeps its text while it folds away. */
function useHeld<T>(value: T | null | undefined): T | undefined {
  const held = useRef<T | undefined>(undefined);
  if (value) held.current = value;
  return held.current;
}
function Notice({ text, alert = true }: { text: string | null; alert?: boolean }) {
  const held = useHeld(text);
  return <AnimatedDisclosure open={Boolean(text)}>
    <p className="lc-chatbot-pages-error lc-chatbot-after" role={text && alert ? "alert" : undefined}>{text ?? held}</p>
  </AnimatedDisclosure>;
}
/** Panes stay mounted and slide, so a step keeps its scroll and typed text and both directions animate. */
function Pane({ index, step, children }: { index: number; step: number; children: ReactNode }) {
  const pos = index < step ? "before" : index > step ? "after" : "current";
  return <div className="lc-chatbot-slide lc-chatbot-pane lc-scroll-pane" data-pos={pos} role="tabpanel" id={`lc-chatbot-pane-${index}`}
    aria-labelledby={`lc-chatbot-tab-${index}`} inert={pos !== "current"}>{children}</div>;
}
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
  // Starts from the last request; the first request ever starts with no type.
  const [reading, setReading] = useState<ReadingChoice>(loadReadingChoice);
  const [customDraft, setCustomDraft] = useState("");
  const readingFields = choiceFields(reading);
  const readingStyle = readingStyleOf(reading);
  const readingError = !reading.kind ? "Choose what kind of document this is."
    : reading.notes === "custom" && readingFields.length === 0 ? "Pick at least one field for Custom." : null;
  const chooseKind = (kind: ReadingKind) => setReading((current) => ({
    ...current,
    kind,
    // A preset belongs to its kind; switching kinds starts from that kind's first.
    notes: current.notes === "free" || current.notes === "custom" || PRESETS[kind].some((preset) => preset.id === current.notes)
      ? current.notes : PRESETS[kind][0]!.id,
  }));
  const toggleCustomField = (label: string) => setReading((current) => {
    if (!current.kind) return current;
    const fields = current.custom[current.kind] ?? [];
    const next = fields.some((field) => field.toLowerCase() === label.toLowerCase())
      ? fields.filter((field) => field.toLowerCase() !== label.toLowerCase())
      : fields.length >= MAX_NOTE_FIELDS ? fields : [...fields, label];
    return { ...current, custom: { ...current.custom, [current.kind]: next } };
  });
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
  const [step, setStep] = useState(0);
  const [visited, setVisited] = useState<ReadonlySet<number>>(() => new Set());
  const [view, setView] = useState<"steps" | "history">("steps");
  const goTo = (next: number) => {
    if (next === step) return;
    setVisited(new Set([...visited, step])); setStep(next);
  };
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
      else if (view === "history") setView("steps");
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, view, onClose]);
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
    if (inputError || attachmentError || readingError || prepared === null || busy) return;
    setBusy(true); setMessage(null);
    try {
      saveReadingChoice(reading);
      const references = prepared.flatMap((entry) => entry.reference ? [entry.reference] : []);
      if (selectedRequest === "selection" && onSelectionRequest) {
        const sent = await onSelectionRequest({ focus: focus.trim(), perPage, references, reading: readingStyle });
        rememberSelectionRun(docId, { id: sent.id, doc_id: docId, doc_name: docName, request_type: "selection",
          answer_mode: answerMode, ...(readingStyle ? { reading: readingStyle } : {}),
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
          pages: requestedPages, palette: [...palette], workspace_items: [...workspaceItems], references,
          ...(readingStyle ? { reading: readingStyle } : {}) });
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
  const kindLabel = READING_KINDS.find((entry) => entry.kind === reading.kind)?.label;
  const requestOptions = (hasSelection ? ["selection", "page", "pages"] as const : ["page", "pages"] as const)
    .map((kind) => ({ value: kind, label: kind === "selection" ? "Selection" : kind === "page" ? "This page" : "Page range" }));
  const notesOptions = reading.kind ? [{ value: "free", label: "Free-form" }, ...PRESETS[reading.kind].map((preset) => ({ value: preset.id, label: preset.label })), { value: "custom", label: "Custom" }] : [];
  const densityLabel = DENSITY.find((option) => option.perPage === perPage)?.label ?? "";
  const pagesText = selectedRequest === "selection" ? "Selected text" : selectedRequest === "page" ? pageLabel(currentPage, currentPage) : pageLabel(from, to);
  const attachedTitles = attachments.map((attachment) => attachment.title || (attachment.kind === "pages" ? pageLabel(attachment.from, attachment.to) : attachment.docId));
  const reviewRows: [string, string, number][] = [
    ["Pages", pagesText, 0], ["Focus", focus.trim() || "None", 0], ["Footnotes", `${densityLabel} · about ${perPage} per page`, 0],
    ["Document", kindLabel ?? "Not chosen yet", 1],
    ["Themes", !reading.kind ? "Not chosen yet" : reading.notes === "free" ? "Chosen by ChatBot" : readingFields.join(", ") || "None picked", 1],
    ["Context", attachedTitles.join(", ") || "None", 2],
  ];
  const sentence = reviewSentence({ request: selectedRequest, pagesText, focus: focus.trim(), perPage, kindLabel, free: reading.notes === "free",
    fields: readingFields, fill: reading.fill, attached: attachedTitles });
  const nextBlocked = step === 0 ? Boolean(inputError) : step === 1 ? Boolean(readingError) : false;
  const skipTarget = inputError ? 0 : readingError ? 1 : REVIEW;
  const startBlocked = Boolean(inputError || attachmentError || readingError) || prepared === null || busy;
  const heldMessage = useHeld(message);
  const onTabKey = (event: ReactKeyEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = (step + (event.key === "ArrowRight" ? 1 : -1) + STEPS.length) % STEPS.length;
    goTo(next); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  const showHistory = view === "history" && runs.length > 0;
  return (
    <div className="lc-chatbot-pages-scrim" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <DialogFrame className="lc-settings-dialog lc-chatbot-pages" titleId="lc-chatbot-dialog-title" title="ChatBot" subtitle="" icon={CHATBOT_ICON}
        shape="blocky" ariaLabel="ChatBot" onClose={onClose}>
        <AnimatePresence initial={false}>
          {runs.length ? <motion.button key="history-link" type="button" className="lc-chatbot-history-link" aria-pressed={showHistory}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
            onClick={() => setView(showHistory ? "steps" : "history")}>
            <span key={showHistory ? "new" : "past"} className="lc-chatbot-fade">{showHistory ? "New request" : "History"}</span>
          </motion.button> : null}
        </AnimatePresence>
        <div className="lc-chatbot-layers">
          <div className="lc-chatbot-slide lc-chatbot-layer" data-pos={showHistory ? "before" : "current"} inert={showHistory}>
            <div className="lc-chatbot-steps" role="tablist" aria-label="Steps" onKeyDown={onTabKey}
              style={{ "--step": step } as CSSProperties}>
              {STEPS.map((name, index) => {
                const done = visited.has(index) && index !== step && !(index === 1 && readingError);
                return <button key={name} type="button" role="tab" id={`lc-chatbot-tab-${index}`} aria-selected={index === step} aria-controls={`lc-chatbot-pane-${index}`}
                  tabIndex={index === step ? 0 : -1} className="lc-chatbot-step" data-done={done ? "" : undefined} onClick={() => goTo(index)}>
                  <span className="lc-chatbot-step-n" aria-hidden="true">{done ? "✓" : index + 1}</span>{name}
                  {index === 1 && readingError && index !== step ? <i className="lc-chatbot-step-dot" aria-label="Needs a choice" /> : null}
                </button>;
              })}
              <span className="lc-chatbot-steps-thumb" aria-hidden="true" />
            </div>
            <div className="lc-chatbot-stage">
              <Pane index={0} step={step}>
                <div className="lc-chatbot-field">
                  <div className="lc-settings-subhead">Which pages do you want to annotate?</div>
                  <SlidingSegmented ariaLabel="Request type" options={requestOptions} value={selectedRequest} onChange={setRequest} />
                  <AnimatedDisclosure open={selectedRequest === "pages"}>
                    <div className="lc-chatbot-page-range lc-chatbot-after">
                      <label>From page<input type="number" min={1} max={pageCount || undefined} value={from || ""} onChange={(event) => setFrom(Number(event.target.value))} /></label>
                      <label>To page<input type="number" min={1} max={pageCount || undefined} value={to || ""} onChange={(event) => setTo(Number(event.target.value))} /></label>
                    </div>
                  </AnimatedDisclosure>
                  <AnimatedDisclosure open={selectedRequest !== "pages"}>
                    <p className="lc-settings-hint lc-chatbot-after"><span key={pagesText + selectedRequest} className="lc-chatbot-fade">{selectedRequest === "selection" ? selection?.text.slice(0, 160) : pageLabel(currentPage, currentPage)}</span></p>
                  </AnimatedDisclosure>
                  <Notice text={inputError} />
                </div>
                <div className="lc-chatbot-field">
                  <div className="lc-settings-subhead">What do you want the bot to focus on? <span className="lc-chatbot-optional">optional</span></div>
                  <textarea aria-label="Focus" rows={3} maxLength={1000} value={focus} onChange={(event) => setFocus(event.target.value)} placeholder="For example: key definitions and proofs" />
                </div>
                <div className="lc-chatbot-field">
                  <div className="lc-settings-subhead">How many footnotes per page?</div>
                  <SlidingSegmented ariaLabel="How many footnotes" value={perPage} onChange={setPerPage}
                    options={DENSITY.map((option) => ({ value: option.perPage, label: option.label, sub: `about ${option.perPage}` }))} />
                </div>
              </Pane>
              <Pane index={1} step={step}>
                <div className="lc-chatbot-field">
                  <div className="lc-settings-subhead">What kind of document is this?</div>
                  <ChoicePicker ariaLabel="Kind of text" placeholder="Choose a kind" value={reading.kind} onChange={(kind) => chooseKind(kind as ReadingKind)}
                    options={READING_KINDS.map(({ kind, label }) => ({ value: kind, label }))} />
                  <AnimatedDisclosure open={!reading.kind}>
                    <p className="lc-settings-hint lc-chatbot-after">ChatBot writes for the kind of text: a story gets a reading companion, a textbook a study guide.</p>
                  </AnimatedDisclosure>
                </div>
                <AnimatedDisclosure open={Boolean(reading.kind)}>
                  {reading.kind ? <div className="lc-chatbot-field lc-chatbot-after">
                    <div className="lc-settings-subhead">What themes do you want the footnotes to include?</div>
                    <ChoicePicker ariaLabel="Notes" value={reading.notes} onChange={(notes) => setReading({ ...reading, notes })} options={notesOptions} />
                    <p className="lc-settings-hint"><span key={`${reading.kind}-${reading.notes}`} className="lc-chatbot-fade">{reading.notes === "free" ? "ChatBot shapes each footnote itself."
                      : readingFields.length ? readingFields.join(" · ") : "Pick the fields below."}</span></p>
                    <AnimatedDisclosure open={reading.notes === "custom"}>
                      <div className="lc-chatbot-field lc-chatbot-after">
                        <SettingsChoices className="lc-settings-choice lc-settings-choice-compact lc-chatbot-fields" aria-label="Custom fields">
                          {[...new Set([...fieldsFor(reading.kind), ...readingFields])].map((label) => {
                            const on = readingFields.some((field) => field.toLowerCase() === label.toLowerCase());
                            return <button key={label} type="button" aria-pressed={on} className={`lc-settings-choice-option${on ? " is-active" : ""}`}
                              onClick={() => toggleCustomField(label)}>{label}</button>;
                          })}
                        </SettingsChoices>
                        <div className="lc-chatbot-field-add">
                          <input aria-label="Name your own field" placeholder="Name your own field" maxLength={40} value={customDraft}
                            onChange={(event) => setCustomDraft(event.target.value)} onKeyDown={(event) => {
                              if (event.key !== "Enter" || !customDraft.trim()) return;
                              event.preventDefault(); toggleCustomField(customDraft.trim()); setCustomDraft("");
                            }} />
                          <button type="button" className="lc-secondary lc-dialog-action" disabled={!customDraft.trim()}
                            onClick={() => { toggleCustomField(customDraft.trim()); setCustomDraft(""); }}>Add</button>
                        </div>
                      </div>
                    </AnimatedDisclosure>
                    <AnimatedDisclosure open={reading.notes !== "free"}>
                      <div className="lc-chatbot-field lc-chatbot-after">
                        <div className="lc-settings-subhead">How many fields should each footnote fill?</div>
                        <SlidingSegmented ariaLabel="Fill" value={reading.fill} onChange={(fill) => setReading({ ...reading, fill })}
                          options={[{ value: "best", label: "Best fit" }, { value: "all", label: "All fields" }]} />
                        <p className="lc-settings-hint"><span key={reading.fill} className="lc-chatbot-fade">{reading.fill === "best"
                          ? "Only the fields with something worthwhile to say about each passage."
                          : "Every field for every footnote, a sentence or two each."}</span></p>
                      </div>
                    </AnimatedDisclosure>
                  </div> : null}
                </AnimatedDisclosure>
                <Notice text={reading.kind ? readingError : null} />
              </Pane>
              <Pane index={2} step={step}>
                <div className="lc-chatbot-field">
                  <div className="lc-settings-subhead">Attach any relevant context <span className="lc-chatbot-optional">optional</span></div>
                  {files.length ? <SettingsChoices className="lc-settings-choice lc-chatbot-files" aria-label="Library files">{files.map((file) => {
                    const picked = attachments.some((attachment) => attachment.kind === "file" && attachment.docId === file.docId);
                    return <button key={file.docId} type="button" className={`lc-settings-choice-option${picked ? " is-active" : ""}`} aria-pressed={picked}
                      onClick={() => setAttachments(picked ? attachments.filter((entry) => entry.kind !== "file" || entry.docId !== file.docId) : [...attachments, { kind: "file", ...file }])}>{file.title}</button>;
                  })}</SettingsChoices> : <p className="lc-settings-hint">No notes or code files in your library.</p>}
                </div>
                <div className="lc-chatbot-field">
                  <div className="lc-settings-subhead">Pages of this PDF</div>
                  <div className="lc-chatbot-page-range lc-chatbot-page-range-add">
                    <label>Attach from page<input type="number" min={1} max={pageCount || undefined} value={attachFrom || ""} onChange={(event) => setAttachFrom(Number(event.target.value))} /></label>
                    <label>Attach to page<input type="number" min={1} max={pageCount || undefined} value={attachTo || ""} onChange={(event) => setAttachTo(Number(event.target.value))} /></label>
                    <button type="button" className="lc-secondary lc-dialog-action" disabled={Boolean(attachedRangeError)} onClick={() => {
                      if (!attachments.some((entry) => entry.kind === "pages" && entry.from === attachFrom && entry.to === attachTo)) setAttachments([...attachments, { kind: "pages", from: attachFrom, to: attachTo, title: pageLabel(attachFrom, attachTo) }]);
                    }}>Add pages</button>
                  </div>
                  <Notice text={attachedRangeError} alert={false} />
                </div>
                <AnimatePresence initial={false}>
                  {attachments.length ? <motion.div key="attached" className="lc-chatbot-attached" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}>
                    <ul className="lc-chatbot-attachments" aria-label="Attachments"><AnimatePresence initial={false}>{attachments.map((attachment, index) => <motion.li layout
                      key={attachment.kind === "file" ? attachment.docId : `${attachment.from}-${attachment.to}`}
                      initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
                      <div><strong>{attachment.title || (attachment.kind === "pages" ? pageLabel(attachment.from, attachment.to) : attachment.docId)}</strong><small>{prepared?.[index] ? prepared[index]!.error ?? sizeLabel(prepared[index]!.chars) : "Reading…"}</small></div>
                      <button type="button" className="lc-dialog-action" aria-label={`Remove attachment ${index + 1}`} onClick={() => setAttachments(attachments.filter((_, at) => at !== index))}>Remove</button>
                    </motion.li>)}</AnimatePresence></ul>
                    <p className="lc-settings-hint">{prepared ? sizeLabel(prepared.reduce((total, entry) => total + entry.chars, 0)) : "Reading attachments…"} / {REFERENCES_TOTAL_CHARS.toLocaleString()} total</p>
                  </motion.div> : null}
                </AnimatePresence>
                <Notice text={attachmentError} />
              </Pane>
              <Pane index={3} step={step}>
                <div className="lc-chatbot-field">
                  <div className="lc-settings-subhead">Review</div>
                  <dl className="lc-chatbot-review">{reviewRows.map(([name, value, target]) => <div key={name} className="lc-chatbot-review-row">
                    <dt>{name}</dt><dd>{value}</dd>
                    <button type="button" className="lc-chatbot-review-edit" aria-label={`Edit ${name}`} onClick={() => goTo(target)}>Edit</button>
                  </div>)}</dl>
                  <p className="lc-chatbot-review-note"><span key={sentence} className="lc-chatbot-fade">{sentence}</span></p>
                </div>
                <Notice text={inputError ?? attachmentError ?? readingError} alert={false} />
                <AnimatedDisclosure open={answerMode === "llm" && selectedRequest !== "selection"}>
                  <p className="lc-settings-hint lc-chatbot-after">Your AI model answers single footnotes; page runs need an assistant.</p>
                </AnimatedDisclosure>
                <AnimatedDisclosure open={Boolean(message && !active)}>
                  <p className="lc-settings-hint" role={message && !active ? "status" : undefined}>{message ?? heldMessage}</p>
                </AnimatedDisclosure>
              </Pane>
            </div>
            <footer className="lc-chatbot-foot">
              <div className="lc-chatbot-skip" data-open={step < REVIEW ? "" : undefined}>
                <div><button type="button" className="lc-chatbot-skip-link" tabIndex={step < REVIEW ? 0 : -1} disabled={step >= REVIEW || skipTarget === step}
                  onClick={() => goTo(skipTarget)}>Skip</button></div>
              </div>
              <div className="lc-chatbot-nav">
                <div className="lc-chatbot-back-slot" data-open={step > 0 ? "" : undefined}>
                  <button type="button" className="lc-secondary lc-dialog-action" tabIndex={step > 0 ? 0 : -1} onClick={() => goTo(step - 1)}>Back</button>
                </div>
                <button type="button" className="lc-primary lc-dialog-action lc-chatbot-primary" disabled={step < REVIEW ? nextBlocked : startBlocked}
                  onClick={() => step < REVIEW ? goTo(step + 1) : void start()}>
                  <span key={step < REVIEW ? "next" : busy ? "busy" : "start"} className="lc-chatbot-fade">{step < REVIEW ? "Next" : busy ? "Sending…" : "Start"}</span>
                </button>
              </div>
            </footer>
          </div>
          <div className="lc-chatbot-slide lc-chatbot-layer" data-pos={showHistory ? "current" : "after"} inert={!showHistory}>
            <section className="lc-chatbot-history" aria-label="History">
              <div className="lc-settings-subhead">History</div>
              <div className="lc-settings-choice">{runs.map((run) => <button key={run.id} type="button" className="lc-settings-choice-option lc-chatbot-history-row" onClick={() => setActiveId(run.id)}>{runLabel(run, statusFor(run))}</button>)}</div>
            </section>
          </div>
        </div>
      </DialogFrame>
      {active ? <div className="lc-chatbot-run-scrim" onClick={(event) => { if (event.target === event.currentTarget) setActiveId(null); }}>
          <DialogFrame className="lc-settings-dialog lc-chatbot-run-popup" titleId="lc-chatbot-run-title" title={requestLabel(active)} subtitle="" icon={CHATBOT_ICON}
            shape="blocky" ariaLabel="Run details" onClose={() => setActiveId(null)}>
            <div className="lc-settings-body lc-dialog-body lc-scroll-pane">
              <p className="lc-settings-hint">{pageLabel(active.page_from, active.page_to)} · {DENSITY.find((entry) => entry.perPage === active.per_page)?.label ?? active.per_page} · {statusFor(active)}</p>
              <p className="lc-settings-hint">{readingLabel(active)}</p>
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
