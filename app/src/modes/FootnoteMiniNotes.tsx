import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { CloseNoteIcon, ExpandNoteIcon } from "../components/NoteWindowIcons";
import type { DocFootnote, DocFootnoteNote } from "../util/docFootnotes";
import { footnoteThemeVars } from "../util/footnoteTheme";
import { FootnoteNoteBody } from "./FootnoteNoteBody";
import { subscribePageSurfaceMove } from "./sheetAnchor";
import { clampMiniNoteRect, firstFreeMiniNoteRect, miniNoteKey, resizeMiniNoteRect, type MiniNoteBounds,
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

function sameRect(a: MiniNoteRect | undefined, b: MiniNoteRect | undefined): boolean {
  return a === b || Boolean(a && b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);
}

function panelRects(bounds: MiniNoteBounds): MiniNoteRect[] {
  return [...document.querySelectorAll<HTMLElement>(".lc-footnote-overview")].flatMap(panel => {
    const style = window.getComputedStyle(panel);
    if (style.display === "none" || style.visibility === "hidden") return [];
    const rect = panel.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.right > bounds.left && rect.left < bounds.left + bounds.width &&
      rect.bottom > bounds.top && rect.top < bounds.top + bounds.height ? [rect] : [];
  });
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
  const [bounds, setBounds] = useState<MiniNoteBounds | null>(null);
  const [localPlacements, setLocalPlacements] = useState<MiniNotePlacements>({});
  const reservations = useRef<Record<string, { rect: MiniNoteRect; source: MiniNoteRect | undefined }>>({});
  const [front, setFront] = useState<string | null>(null);
  /*
   * A drag moves the window itself, once per display frame, and saves the
   * place only when the pointer lets go. Saving per pointer event re-rendered
   * the whole workspace and wrote storage up to 240 times a second on a pen.
   */
  const gesture = useRef<{ key: string; pointerId: number; mode: "move" | "resize";
    x: number; y: number; rect: MiniNoteRect; node: HTMLElement | null; live: MiniNoteRect | null; frame: number } | null>(null);
  const placementFor = (key: string) => {
    const external = placements?.[key];
    const reserved = reservations.current[key];
    // Keep a commit visible while its parent catches up; a new external rect wins.
    if (reserved && (!external || sameRect(external, reserved.source) || sameRect(external, reserved.rect))) return reserved.rect;
    return external ?? localPlacements[key];
  };
  const commit = (key: string, rect: MiniNoteRect) => {
    reservations.current[key] = { rect, source: placements?.[key] };
    setLocalPlacements(current => sameRect(current[key], rect) ? current : { ...current, [key]: rect });
    onPlacementChange?.(key, rect);
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
      setBounds(current => sameRect(current ?? undefined, next) ? current : next);
    };
    place();
    return subscribePageSurfaceMove(place);
  }, [getBounds, entries.length]);
  useLayoutEffect(() => {
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const visible = entries.slice(0, MINI_NOTE_LIMIT);
    const occupied = panelRects(bounds);
    for (const entry of visible) {
      const key = miniNoteKey(entry);
      const reserved = reservations.current[key];
      const external = placements?.[key];
      if (reserved && external && (sameRect(external, reserved.rect) || !sameRect(external, reserved.source))) delete reservations.current[key];
      const saved = placementFor(key);
      if (!saved) continue;
      const rect = clampMiniNoteRect(saved, bounds);
      if (!sameRect(saved, rect)) commit(key, rect);
      occupied.push(rect);
    }
    for (const entry of visible) {
      const key = miniNoteKey(entry);
      if (placementFor(key)) continue;
      const rect = firstFreeMiniNoteRect(bounds, occupied);
      // Reserve before publishing so another incoming note cannot take the slot.
      commit(key, rect);
      occupied.push(rect);
    }
  }, [bounds, entries, placements, localPlacements, onPlacementChange]);
  const begin = (event: ReactPointerEvent<HTMLElement>, key: string, rect: MiniNoteRect, mode: "move" | "resize") => {
    if (event.button !== 0) return;
    if (mode === "move" && event.target instanceof Element && event.target.closest("button, a")) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { key, rect, mode, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      node: event.currentTarget.closest<HTMLElement>(".lc-footnote-mini-note"), live: null, frame: 0 };
    setFront(key);
  };
  const paint = () => {
    const drag = gesture.current;
    if (!drag) return;
    drag.frame = 0;
    const rect = drag.live;
    if (!rect || !drag.node) return;
    if (drag.mode === "move") {
      // A slide on its own layer; the page under it is not repainted.
      drag.node.style.willChange = "transform";
      drag.node.style.transform = `translate(${rect.left - drag.rect.left}px, ${rect.top - drag.rect.top}px)`;
      return;
    }
    drag.node.style.width = `${rect.width}px`;
    drag.node.style.height = `${rect.height}px`;
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = gesture.current;
    if (!drag || drag.pointerId !== event.pointerId || !bounds) return;
    event.preventDefault(); event.stopPropagation();
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.live = drag.mode === "move"
      ? clampMiniNoteRect({ ...drag.rect, left: drag.rect.left + dx, top: drag.rect.top + dy }, bounds)
      : resizeMiniNoteRect(drag.rect, dx, dy, bounds);
    if (!drag.node) { commit(drag.key, drag.live); return; }
    if (!drag.frame) drag.frame = requestAnimationFrame(paint);
  };
  const settleDrag = () => {
    const drag = gesture.current;
    gesture.current = null;
    if (!drag) return;
    if (drag.frame) cancelAnimationFrame(drag.frame);
    if (drag.node) {
      // Land where it was shown, in one step, before React catches up.
      if (drag.live) {
        drag.node.style.left = `${drag.live.left}px`;
        drag.node.style.top = `${drag.live.top}px`;
      }
      drag.node.style.transform = "";
      drag.node.style.willChange = "";
    }
    if (drag.live) commit(drag.key, drag.live);
  };
  const finish = (event: ReactPointerEvent<HTMLElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    settleDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  if (!entries.length || !bounds) return null;
  return createPortal(<div className="lc-footnote-mini-tray">
    {entries.slice(0, MINI_NOTE_LIMIT).map((entry) => {
      const key = miniNoteKey(entry);
      const saved = placementFor(key);
      if (!saved) return null;
      const rect = clampMiniNoteRect(saved, bounds);
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
        onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={settleDrag}>
        <strong>{entry.noteNumber ? `Note ${entry.number ?? ""}.${entry.noteNumber}` : `All notes ${entry.number ?? ""}`}</strong>
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
        onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={settleDrag}
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
