import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HoldButton } from "../components/HoldButton";
import { usePopPlacement } from "../components/usePopPlacement";
import { usePresence } from "../components/usePresence";
import { LIBRARY_HOLD_MS } from "../util/gesture";
import {
  bookBytes, formatBytes, versionBytes, versionsByBook,
  type AttachedCopy, type RetainedKind, type RetainedVersion,
} from "../util/retainedVersions";
import "./retainedRow.css";

/** A library row's book, as much as the retained controls need of it. */
export interface RetainedBook { id: string; updatedAt: number; hash?: string }

/**
 * The Recents list's retained copies: which copy each row shows, and sizes.
 *
 * Loaded when the list opens and again after any change (`refresh`). A row's
 * pick is a copy id, so a copy kept meanwhile shifts the numbers without
 * moving the pick to a different copy.
 */
export function useRetainedRows(kind: RetainedKind, open: boolean, books: readonly RetainedBook[], measure = open) {
  const [versions, setVersions] = useState<Map<string, RetainedVersion[]>>(new Map());
  const [attached, setAttached] = useState<Map<string, AttachedCopy[]>>(new Map());
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration(value => value + 1), []);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void versionsByBook(kind).then(next => {
      if (disposed) return;
      setVersions(next.versions); setAttached(next.attached);
      // A pick whose copy is gone falls back to the current version.
      setPicked(current => Object.fromEntries(Object.entries(current)
        .filter(([bookId, id]) => next.versions.get(bookId)?.some(row => row.id === id))));
    }).catch(() => {});
    return () => { disposed = true; };
  }, [kind, open, generation]);
  // Sizes, a book at a time: each reads that book's data and ink once per edit.
  const booksKey = books.map(book => `${book.id}:${book.updatedAt}:${book.hash ?? ""}`).join("|");
  useEffect(() => {
    if (!measure) return;
    let disposed = false;
    void (async () => {
      for (const book of books) {
        if (disposed) return;
        try {
          const bytes = await bookBytes(kind, book.id, book.updatedAt, book.hash);
          if (!disposed) setSizes(current => current[book.id] === bytes ? current : { ...current, [book.id]: bytes });
        } catch { /* a size is a nicety; the row works without it */ }
      }
    })();
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, measure, booksKey]);
  const pick = useCallback((bookId: string, id: string | null) => {
    setPicked(current => {
      const next = { ...current };
      if (id) next[bookId] = id; else delete next[bookId];
      return next;
    });
  }, []);
  const pickedOf = (bookId: string): RetainedVersion | null =>
    versions.get(bookId)?.find(row => row.id === picked[bookId]) ?? null;
  return { versions, attached, sizes, pick, pickedOf, refresh };
}

const DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

/** One line about a copy: "Copy 2 · Oct 19, 10:42 AM · Before updating to a newer file". */
export function copyLine(version: RetainedVersion): string {
  const when = version.editedAt ? new Date(version.editedAt).toLocaleString(undefined, DATE) : "Date unknown";
  return `Copy ${version.number} · ${when} · ${version.reason}`;
}

/**
 * The numbered list between the padlock and the trash: Current, then each
 * retained copy, newest kept first. A trashed copy carries "(!)" in red.
 */
export function VersionPicker({ name, versions, picked, currentBytes, currentHash, disabled = false, onPick }: {
  name: string;
  versions: readonly RetainedVersion[];
  picked: RetainedVersion | null;
  currentBytes?: number;
  currentHash?: string;
  disabled?: boolean;
  onPick: (id: string | null) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  const placed = usePopPlacement(buttonRef, menuRef, presence.mounted, versions.length, "below", "right");
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); buttonRef.current?.focus();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", escape, true); };
  }, [open]);
  if (!versions.length) return null;
  const choose = (id: string | null) => { setOpen(false); onPick(id); };
  return <>
    <button ref={buttonRef} type="button"
      className={`lc-version-pick${picked ? " is-picked" : ""}${picked?.trashedAt ? " is-trashed" : ""}`}
      disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      aria-label={picked ? `${name}: showing copy ${picked.number}. Choose a version` : `${name}: ${versions.length} retained ${versions.length === 1 ? "copy" : "copies"}. Choose a version`}
      onClick={event => { event.stopPropagation(); setOpen(value => !value); }}>
      <svg className="lc-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5M12 7v5l3 2" /></svg>
      <b>{picked ? picked.number : versions.length}</b>
      {picked?.trashedAt ? <span aria-hidden="true">(!)</span> : null}
    </button>
    {presence.mounted && createPortal(<div ref={menuRef} role="menu" aria-label={`Versions of ${name}`}
      className={`lc-doc-sync-pop lc-tab-hold-pop lc-version-menu${presence.leaving ? " is-leaving" : ""}`} style={placed} inert={presence.leaving}>
      <button type="button" role="menuitemradio" aria-checked={!picked} className={picked ? "" : "is-current"} onClick={() => choose(null)}>
        <span className="lc-version-num">Now</span>
        <span className="lc-version-copy"><strong>Current version</strong>{currentBytes !== undefined && <small>{formatBytes(currentBytes)}</small>}</span>
      </button>
      {versions.map(version => <button key={version.id} type="button" role="menuitemradio" aria-checked={picked?.id === version.id}
        className={`${picked?.id === version.id ? "is-current" : ""}${version.trashedAt ? " is-trashed" : ""}`} onClick={() => choose(version.id)}>
        <span className="lc-version-num">{version.number}{version.trashedAt ? " (!)" : ""}</span>
        <span className="lc-version-copy">
          <strong>{version.editedAt ? new Date(version.editedAt).toLocaleString(undefined, DATE) : "Date unknown"}</strong>
          <small>{version.reason}{version.trashedAt ? " · in the trash" : ""} · {formatBytes(versionBytes(version, currentHash))}</small>
        </span>
      </button>)}
    </div>, document.body)}
  </>;
}

/** Export what the row shows: tap for the annotated document, hold for the backup file. */
export function VersionShare({ name, disabled = false, onAnnotated, onBackup }: {
  name: string;
  disabled?: boolean;
  onAnnotated: () => void;
  onBackup: () => void;
}) {
  return <HoldButton holdMs={LIBRARY_HOLD_MS} label={`Export ${name}`} className="lc-version-share" disabled={disabled}
    ariaLabel={`Export ${name}: tap for the annotated document, hold for the backup file`} dataTip="Tap: document · Hold: backup"
    onTap={onAnnotated} onConfirm={onBackup}>
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12m0 0-4-4m4 4 4-4M5 17v3h14v-3" /></svg>
  </HoldButton>;
}
