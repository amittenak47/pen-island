import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LcClient } from "../api/client";
import type { BookIdentity } from "../util/syncState";
import { BOOK_PASS_ACTIVITY_EVENT, BOOK_PASS_STATUS_EVENT, getBookPassActivity, syncBookPass } from "../util/bookSyncPass";
import { WorkRing } from "./DocIndexChip";
import { bookSyncFailed, librarySyncSummary, loadLibrarySyncResults } from "./LibrarySyncResults";

/** How long a clean finish stays on screen, as the tab's Sync does. */
const LANDED_MS = 2_500;

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
  const [open, setOpen] = useState(false), [details, setDetails] = useState(false);
  const [result, setResult] = useState(loadLibrarySyncResults), [activity, setActivity] = useState(getBookPassActivity);
  const [error, setError] = useState("");
  const [anchor, setAnchor] = useState({ top: 0, left: 8 });
  const [ranHere, setRanHere] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const listId = useId();
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
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      // The tab's notification is 280px wide; keep it on screen at the right edge.
      if (rect) setAnchor({ top: rect.bottom + 8, left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)) });
    };
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !pop.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    };
    place();
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
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
    setError(""); setDetails(false); setRanHere(true); setOpen(true);
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
  const status = syncing ? `syncing, ${synced} synced so far` : failures.length && result ? librarySyncSummary({ time: 0, books: failures }) : result ? "all books synced" : "not synced yet";

  return <>
    <button ref={trigger} type="button"
      className={`lc-icon lc-library-sync-trigger${syncing ? " is-working" : ""}${!syncing && (error || failures.length) ? " is-bad" : ""}`}
      aria-label={syncing && controller.current ? `Cancel sync — ${status}` : `Sync all books — ${status}`}
      title={syncing && controller.current ? "Cancel sync" : "Sync all books"}
      aria-busy={syncing} aria-expanded={open} aria-haspopup="dialog"
      onClick={tap}>
      {syncing
        ? <WorkRing progress={activity.progress} count={synced} />
        : <svg className="lc-icon-svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
            strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6" />
          </svg>}
      {!syncing && failures.length > 0 && <span className="lc-library-sync-dot" aria-hidden="true" />}
    </button>
    {open && createPortal(
      // The tab's Sync notification (`.lc-doc-sync-pop`), so both read the same.
      <div ref={pop} className="lc-doc-sync-pop lc-library-sync-pop" role="status" aria-live="polite"
        style={{ top: anchor.top, left: anchor.left }}>
        <div className="lc-doc-sync-line">{line}</div>
        {!syncing && failures.length > 0 && <>
          <button type="button" className="lc-doc-sync-index lc-library-sync-toggle" aria-expanded={details} aria-controls={listId}
            onClick={() => setDetails(value => !value)}>{details ? "Hide details" : "Show details"}</button>
          {details && <ul id={listId} className="lc-library-sync-list" aria-label="Book sync results">
            {books.map(book => {
              const failed = bookSyncFailed(book);
              const content = <><span className={failed ? "lc-library-sync-bad" : "lc-library-sync-ok"} aria-label={failed ? book.status : "synced"}>{failed ? "✗" : "✓"}</span>
                <span className="lc-library-sync-book"><span title={book.title}>{book.title}</span>{failed && <small title={book.reason}>{book.reason}</small>}</span></>;
              return <li key={`${book.kind}:${book.id}`}>{failed && canOpen(book)
                ? <button type="button" className="lc-library-sync-row" onClick={() => { onOpen({ kind: book.kind, id: book.id }); setOpen(false); }}>{content}</button>
                : <div className="lc-library-sync-row">{content}</div>}</li>;
            })}
          </ul>}
        </>}
      </div>, document.body)}
  </>;
}
