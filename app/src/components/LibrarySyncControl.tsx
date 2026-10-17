import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LcClient } from "../api/client";
import type { BookIdentity } from "../util/syncState";
import { BOOK_PASS_ACTIVITY_EVENT, BOOK_PASS_STATUS_EVENT, getBookPassActivity, syncBookPass } from "../util/bookSyncPass";
import { WorkRing } from "./DocIndexChip";
import { usePopPlacement } from "./usePopPlacement";
import { usePresence } from "./usePresence";
import { bookSyncFailed, librarySyncSummary, loadLibrarySyncResults } from "./LibrarySyncResults";

/** How long a clean finish stays on screen, as the tab's Sync does. */
const LANDED_MS = 2_500;
/** Time to move from the button onto the notification before hover closes it. */
const HOVER_LEAVE_MS = 220;

/**
 * Home's library sync: a refresh icon on the Start row.
 *
 * It behaves like the Sync button on a document's tab. A tap starts the pass
 * (the same one as Pull) and opens the tab's sync notification under it; while
 * it runs the icon is the tab's progress ring with the number of books synced
 * so far inside, and a tap cancels. A clean finish says "synced" and closes;
 * anything that did not sync stays open with the summary and a ✓/✗ list.
 */
export function LibrarySyncControl({ client, canOpen, onOpen }: {
  client: LcClient;
  canOpen(book: BookIdentity): boolean;
  onOpen(book: BookIdentity): void;
}) {
  const [open, setOpen] = useState(false);
  /** Failed opens by default, Succeeded stays folded. */
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({ Failed: true, Succeeded: false });
  const [result, setResult] = useState(loadLibrarySyncResults), [activity, setActivity] = useState(getBookPassActivity);
  const [error, setError] = useState("");
  const [hover, setHover] = useState(false);
  const leaveTimer = useRef(0);
  const [ranHere, setRanHere] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const completed = () => setResult(loadLibrarySyncResults());
    const running = () => setActivity(getBookPassActivity());
    window.addEventListener(BOOK_PASS_STATUS_EVENT, completed);
    window.addEventListener(BOOK_PASS_ACTIVITY_EVENT, running);
    // A pass may finish between render and subscription.
    completed(); running();
    return () => {
      window.removeEventListener(BOOK_PASS_STATUS_EVENT, completed);
      window.removeEventListener(BOOK_PASS_ACTIVITY_EVENT, running);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !pop.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const books = [...(result?.books ?? [])].sort((a, b) => Number(bookSyncFailed(b)) - Number(bookSyncFailed(a)));
  const failures = books.filter(bookSyncFailed);
  const syncing = activity.library;
  const synced = syncing && activity.progress ? Math.max(0, activity.progress.done - 1) : 0;

  // A clean finish of a run started here lands like the tab: "synced", then gone.
  useEffect(() => {
    if (!open || !ranHere || syncing || error || failures.length) return;
    const timer = window.setTimeout(() => setOpen(false), LANDED_MS);
    return () => window.clearTimeout(timer);
  }, [open, ranHere, syncing, error, failures.length]);

  const start = async () => {
    const abort = new AbortController(); controller.current = abort;
    setError(""); setRanHere(true); setOpen(true);
    // The same pass as Pull: send and receive every changed book, add books
    // this device has never had, and repair missing source files.
    try { await syncBookPass(client, { signal: abort.signal, libraryPull: true, onProgress: () => setActivity(getBookPassActivity()) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (controller.current === abort) controller.current = null; }
  };
  const tap = () => {
    if (syncing && controller.current) { controller.current.abort(); return; }
    // A tab's Sync or an automatic pass is running: show it rather than queue another.
    if (activity.busy) { setRanHere(false); setOpen(true); return; }
    void start();
  };

  const line = syncing
    ? activity.progress ? `Syncing ${activity.progress.done} of ${activity.progress.total} books` : "Syncing…"
    : activity.busy ? "Sync in progress"
    : error ? error
    : failures.length && result ? librarySyncSummary(result)
    : result ? "synced" : "not synced";
  // Hover (mouse or pen) shows the status without syncing; touch has no hover.
  const visible = open || hover;
  const enter = (event: { pointerType: string }) => {
    if (event.pointerType === "touch") return;
    window.clearTimeout(leaveTimer.current); setHover(true);
  };
  const leave = () => { window.clearTimeout(leaveTimer.current); leaveTimer.current = window.setTimeout(() => setHover(false), HOVER_LEAVE_MS); };
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  // Above the icon: below it the notification would sit over the Start tiles.
  /*
   * The card slides between widths (its text changes from "Syncing 6 of 20
   * books" to a summary, groups fold): measure the new natural width, start
   * from the old one, transition. CSS cannot transition between two
   * content-sized widths by itself.
   */
  // Opens and closes with motion: the card stays mounted while it fades out.
  const presence = usePresence(visible);
  const lastWidth = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = pop.current;
    if (!presence.mounted || !el) { lastWidth.current = null; return; }
    if (presence.leaving) return;
    el.style.transition = "none";
    el.style.width = "";
    const target = el.getBoundingClientRect().width;
    const from = lastWidth.current;
    lastWidth.current = target;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (from == null || still || Math.abs(from - target) < 1) { el.style.width = `${target}px`; return; }
    el.style.width = `${from}px`;
    void el.offsetWidth;
    el.style.transition = "width 200ms cubic-bezier(0.22, 1, 0.36, 1)";
    el.style.width = `${target}px`;
  }, [presence.mounted, presence.leaving, line, books.length, groupOpen, syncing]);
  const placed = usePopPlacement(trigger, pop, presence.mounted, `${line}|${books.length}`, "above");
  const status = syncing ? `syncing, ${synced} synced so far` : failures.length && result ? librarySyncSummary({ time: 0, books: failures }) : result ? "all books synced" : "not synced yet";

  return <>
    <button ref={trigger} type="button"
      className={`lc-icon lc-library-sync-trigger${syncing ? " is-working" : ""}${!syncing && (error || failures.length) ? " is-bad" : ""}`}
      aria-label={syncing && controller.current ? `Cancel sync — ${status}` : `Sync all books — ${status}`}
      aria-busy={syncing} aria-expanded={open} aria-haspopup="dialog"
      onClick={tap} onPointerEnter={enter} onPointerLeave={leave}>
      {syncing
        ? <span className="lc-library-sync-face" key="ring"><WorkRing progress={activity.progress} count={synced} /></span>
        : <svg key="icon" className="lc-icon-svg lc-library-sync-face" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
            strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6" />
          </svg>}
      {!syncing && failures.length > 0 && <span className="lc-library-sync-dot" aria-hidden="true" />}
    </button>
    {presence.mounted && createPortal(
      // The tab's Sync notification (`.lc-doc-sync-pop`), so both read the same.
      <div ref={pop} className={`lc-doc-sync-pop lc-library-sync-pop${presence.leaving ? " is-leaving" : ""}`} role="status" aria-live="polite"
        style={placed} onPointerEnter={enter} onPointerLeave={leave}>
        <div className="lc-doc-sync-line">{line}</div>
        {!syncing && books.length > 0 && <div className="lc-library-sync-groups">
          {([["Failed", failures, true], ["Succeeded", books.filter(book => !bookSyncFailed(book)), false]] as const)
            .filter(([, rows]) => rows.length > 0).map(([label, rows, failed]) => (
            // Not <details>: its open/close is instant. This one slides (CSS grid rows).
            <div key={label} className="lc-library-sync-group" data-open={groupOpen[label] || undefined}>
              <button type="button" className={`lc-library-sync-summary ${failed ? "lc-library-sync-bad" : "lc-library-sync-ok"}`}
                aria-expanded={groupOpen[label]} onClick={() => setGroupOpen(open => ({ ...open, [label]: !open[label] }))}>
                <span className="lc-library-sync-caret" aria-hidden="true">▸</span>{label} ({rows.length})
              </button>
              <div className="lc-library-sync-fold">
              <ul className="lc-library-sync-list" aria-label={`${label} books`} inert={!groupOpen[label]}>
                {rows.map(book => {
                  // Failure messages start with the book's title; the row already shows it.
                  const reason = book.reason.startsWith(`${book.title}: `) ? book.reason.slice(book.title.length + 2) : book.reason;
                  const content = <><span className={failed ? "lc-library-sync-bad" : "lc-library-sync-ok"} aria-hidden="true">{failed ? "✗" : "✓"}</span>
                    <span className="lc-library-sync-book" title={failed ? `${book.title}: ${reason}` : book.title}>
                      <span className="lc-library-sync-title">{book.title}</span>{failed && <small>{reason}</small>}</span></>;
                  return <li key={`${book.kind}:${book.id}`}>{failed && canOpen(book)
                    ? <button type="button" className="lc-library-sync-row" onClick={() => { onOpen({ kind: book.kind, id: book.id }); setOpen(false); }}>{content}</button>
                    : <div className="lc-library-sync-row">{content}</div>}</li>;
                })}
              </ul>
              </div>
            </div>
          ))}
        </div>}
      </div>, document.body)}
  </>;
}
