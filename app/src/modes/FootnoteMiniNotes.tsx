import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { CloseNoteIcon, ExpandNoteIcon } from "../components/NoteWindowIcons";
import type { DocFootnote, DocFootnoteNote } from "../util/docFootnotes";
import { footnoteThemeVars } from "../util/footnoteTheme";
import { FootnoteNoteBody } from "./FootnoteNoteBody";
import { subscribePageSurfaceMove } from "./sheetAnchor";
import { clampMiniNoteRect, defaultMiniNoteRect, miniNoteKey, resizeMiniNoteRect, type MiniNoteBounds,
  type MiniNotePlacements, type MiniNoteRect } from "../util/miniNoteWindows";

export const MINI_NOTE_LIMIT = 3;
export type MiniNoteRef = { footnoteId: string; noteId: string };

export function openMiniNote(current: readonly MiniNoteRef[], incoming: MiniNoteRef): MiniNoteRef[] {
  if (current.some(note => note.footnoteId === incoming.footnoteId && note.noteId === incoming.noteId)) return [...current];
  return current.length < MINI_NOTE_LIMIT ? [...current, incoming] : [...current];
}

export interface MiniNoteEntry extends MiniNoteRef {
  footnote: DocFootnote;
  note: DocFootnoteNote;
  number?: number;
  noteNumber: number;
  theme: { color: string; palette: readonly string[] };
}

/** Separate windows share a compact tray, leaving the footnote card available. */
export function FootnoteMiniNotes({ entries, getBounds, onClose, onOpenFullNote, onOpenExternal,
  placements, onPlacementChange }: {
  entries: readonly MiniNoteEntry[];
  getBounds: () => DOMRect;
  onClose: (ref: MiniNoteRef) => void;
  onOpenFullNote?: (ref: MiniNoteRef) => void;
  onOpenExternal: (url: string) => void;
  placements?: MiniNotePlacements;
  onPlacementChange?: (key: string, rect: MiniNoteRect) => void;
}) {
  const [bounds, setBounds] = useState<MiniNoteBounds>({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight });
  const [localPlacements, setLocalPlacements] = useState<MiniNotePlacements>({});
  const [front, setFront] = useState<string | null>(null);
  const gesture = useRef<{ key: string; pointerId: number; mode: "move" | "resize";
    x: number; y: number; rect: MiniNoteRect } | null>(null);
  const currentPlacements = placements ?? localPlacements;
  const commit = (key: string, rect: MiniNoteRect) => {
    if (onPlacementChange) onPlacementChange(key, rect);
    else setLocalPlacements(current => ({ ...current, [key]: rect }));
  };
  useLayoutEffect(() => {
    const place = () => {
      const box = getBounds();
      const view = window.visualViewport;
      const left = Math.max(box.left, view?.offsetLeft ?? 0);
      const top = Math.max(box.top, view?.offsetTop ?? 0);
      const right = Math.min(box.right, (view?.offsetLeft ?? 0) + (view?.width ?? window.innerWidth));
      const bottom = Math.min(box.bottom, (view?.offsetTop ?? 0) + (view?.height ?? window.innerHeight));
      const next = { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
      setBounds(current => Object.keys(next).every(key => current[key as keyof MiniNoteBounds] === next[key as keyof MiniNoteBounds]) ? current : next);
    };
    place();
    return subscribePageSurfaceMove(place);
  }, [getBounds, entries.length]);
  const begin = (event: ReactPointerEvent<HTMLElement>, key: string, rect: MiniNoteRect, mode: "move" | "resize") => {
    if (event.button !== 0) return;
    if (mode === "move" && event.target instanceof Element && event.target.closest("button, a")) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { key, rect, mode, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setFront(key);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = gesture.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    commit(drag.key, drag.mode === "move"
      ? clampMiniNoteRect({ ...drag.rect, left: drag.rect.left + dx, top: drag.rect.top + dy }, bounds)
      : resizeMiniNoteRect(drag.rect, dx, dy, bounds));
  };
  const finish = (event: ReactPointerEvent<HTMLElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  if (!entries.length) return null;
  return createPortal(<div className="lc-footnote-mini-tray">
    {entries.slice(0, MINI_NOTE_LIMIT).map((entry, index) => {
      const key = miniNoteKey(entry);
      const rect = clampMiniNoteRect(currentPlacements[key] ?? defaultMiniNoteRect(index, Math.min(entries.length, MINI_NOTE_LIMIT), bounds), bounds);
      return <section key={key}
      className={`lc-footnote-mini-note${entry.footnote.kind === "ai" && !entry.footnote.pending ? " is-chatbot-complete" : ""}`}
      role="dialog" aria-label={`Mini note ${entry.number ?? ""}.${entry.noteNumber}`}
      data-footnote-id={entry.footnoteId} data-note-id={entry.noteId}
      style={{ ...footnoteThemeVars(entry.theme.color, entry.theme.palette), ...rect, zIndex: key === front ? 2 : 1 }}
      onPointerDownCapture={() => setFront(key)}
      onKeyDown={event => {
        if (event.key !== "Escape") return;
        event.preventDefault(); event.stopPropagation(); onClose(entry);
      }}>
      <header className="lc-footnote-note-head lc-footnote-note-drag" title="Drag to move note"
        onPointerDown={event => begin(event, key, rect, "move")} onPointerMove={move}
        onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { gesture.current = null; }}>
        <strong>Note {entry.number ?? ""}.{entry.noteNumber}</strong>
        <div className="lc-footnote-note-actions">
          {onOpenFullNote && <button type="button" className="lc-footnote-mark-tool" aria-label="Open note in tab"
            title="Open note in tab" onClick={() => onOpenFullNote(entry)}><ExpandNoteIcon /></button>}
          <button type="button" className="lc-footnote-mark-tool" aria-label="Close mini note"
            title="Close mini note" onClick={() => onClose(entry)}><CloseNoteIcon /></button>
        </div>
      </header>
      <FootnoteNoteBody note={entry.note} onOpenExternal={onOpenExternal} />
      <button type="button" className="lc-footnote-note-resize" aria-label="Resize mini note" title="Drag to resize note"
        onPointerDown={event => begin(event, key, rect, "resize")} onPointerMove={move}
        onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { gesture.current = null; }}
        onKeyDown={event => {
          const steps = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] };
          const step = steps[event.key as keyof typeof steps];
          if (!step) return;
          event.preventDefault(); event.stopPropagation();
          commit(key, resizeMiniNoteRect(rect, step[0]!, step[1]!, bounds));
        }}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden><path d="M3 10 10 3M7 10l3-3" /></svg></button>
    </section>; })}
  </div>, document.body);
}
