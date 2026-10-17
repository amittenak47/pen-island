import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LcClient } from "../api/client";
import type { BookIdentity } from "../util/syncState";
import { BOOK_PASS_ACTIVITY_EVENT, BOOK_PASS_STATUS_EVENT, getBookPassActivity, syncBookPass } from "../util/bookSyncPass";
import { bookSyncFailed, librarySyncSummary, loadLibrarySyncResults } from "./LibrarySyncResults";

export function LibrarySyncControl({ client, canOpen, onOpen, label }: {
  client: LcClient;
  canOpen(book: BookIdentity): boolean;
  onOpen(book: BookIdentity): void;
  /** Visible text beside the icon (Home's Start row); icon-only without it. */
  label?: string;
}) {
  const [open, setOpen] = useState(false), [showAll, setShowAll] = useState(false);
  const [result, setResult] = useState(loadLibrarySyncResults), [activity, setActivity] = useState(getBookPassActivity);
  const [error, setError] = useState("");
  const [anchor, setAnchor] = useState({ top: 0, right: 8 });
  const trigger = useRef<HTMLButtonElement>(null), popover = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const listId = useId(), popoverId = useId();
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
      const rect = trigger.current!.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 16);
      setAnchor({ top: rect.bottom + 6, right: Math.min(window.innerWidth - width - 8, Math.max(8, window.innerWidth - rect.right)) });
    };
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) setOpen(false);
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
  const start = async () => {
    if (getBookPassActivity().busy) return;
    const abort = new AbortController(); controller.current = abort; setError("");
    // The same pass as Pull: send and receive every changed book, add books
    // this device has never had, and repair missing source files.
    try { await syncBookPass(client, { signal: abort.signal, libraryPull: true, onProgress: () => setActivity(getBookPassActivity()) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (controller.current === abort) controller.current = null; }
  };
  const books = [...(result?.books ?? [])].sort((a, b) => Number(bookSyncFailed(b)) - Number(bookSyncFailed(a)));
  const failures = books.filter(bookSyncFailed);
  const summary = result ? librarySyncSummary(result) : "Not synced yet";
  const status = activity.library ? "Syncing" : failures.length ? librarySyncSummary({ time: 0, books: failures }) : result ? "All books synced" : "Not synced yet";
  const visible = showAll ? books : failures;
  return <>
    <button ref={trigger} type="button" className={label ? "lc-secondary lc-library-sync-trigger has-label" : "lc-icon lc-library-sync-trigger"} aria-label={`Sync all books — ${status}`}
      title={`Sync all books — ${status}`} aria-expanded={open} aria-controls={open ? popoverId : undefined} aria-haspopup="dialog"
      onClick={() => { setShowAll(false); setOpen(value => !value); }}>
      <svg className={`lc-icon-svg${activity.library ? " lc-library-sync-spinning" : ""}`} viewBox="0 0 24 24" width="16" height="16"
        fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6" />
      </svg>
      {label && <span className="lc-library-sync-label">{label}</span>}
      {failures.length > 0 && <span className="lc-library-sync-dot" aria-hidden="true" />}
    </button>
    {open && createPortal(<div ref={popover} id={popoverId} role="dialog" aria-label="Library sync" className="lc-library-sync-popover"
      style={{ top: anchor.top, right: anchor.right }}>
      <button type="button" className="lc-secondary" disabled={activity.busy} onClick={() => void start()}>Sync all books</button>
      {activity.busy && <p role="status">{activity.progress ? `Syncing ${activity.progress.done} of ${activity.progress.total} books` : "Sync in progress"}</p>}
      {controller.current && activity.busy && <button type="button" className="lc-secondary" onClick={() => controller.current?.abort()}>Cancel</button>}
      <p className="lc-library-sync-summary">{summary}{result && ` · ${new Date(result.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}</p>
      {error && <p role="alert">{error}</p>}
      {books.length > 0 && <>
        <button type="button" className="lc-secondary" aria-expanded={showAll} aria-controls={listId} onClick={() => setShowAll(value => !value)}>{showAll ? "Show less" : "Show all"}</button>
        {visible.length > 0 && <ul id={listId} className="lc-library-sync-list" aria-label="Book sync results">
          {visible.map(book => {
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
