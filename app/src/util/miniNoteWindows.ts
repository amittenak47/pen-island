import type { FootnoteNoteRef } from "./tabs";

export interface MiniNoteRect { left: number; top: number; width: number; height: number }
export interface MiniNoteBounds extends MiniNoteRect {}
export type MiniNotePlacements = Record<string, MiniNoteRect>;
export function miniNoteKey(ref: { footnoteId: string; noteId: string }): string {
  return `${ref.footnoteId}:${ref.noteId}`;
}

/** Session-only window positions survive workspace eviction without changing book data. */
const savedPlacements = new Map<string, MiniNotePlacements>();
function copyMiniNotePlacements(placements: MiniNotePlacements): MiniNotePlacements {
  return Object.fromEntries(Object.entries(placements).map(([key, rect]) => [key, { ...rect }]));
}
export function loadMiniNotePlacements(docId: string | null | undefined): MiniNotePlacements {
  return copyMiniNotePlacements(docId ? savedPlacements.get(docId) ?? {} : {});
}
export function saveMiniNotePlacements(docId: string | null | undefined, placements: MiniNotePlacements): void {
  if (!docId) return;
  savedPlacements.set(docId, copyMiniNotePlacements(placements));
}

export function clampMiniNoteRect(rect: MiniNoteRect, bounds: MiniNoteBounds): MiniNoteRect {
  const margin = 8;
  const availableWidth = Math.max(0, bounds.width - margin * 2);
  const availableHeight = Math.max(0, bounds.height - margin * 2);
  const width = Math.min(availableWidth, Math.max(Math.min(180, availableWidth), rect.width));
  const height = Math.min(availableHeight, Math.max(Math.min(120, availableHeight), rect.height));
  const left = Math.min(Math.max(bounds.left + margin, rect.left), bounds.left + bounds.width - margin - width);
  const top = Math.min(Math.max(bounds.top + margin, rect.top), bounds.top + bounds.height - margin - height);
  return { left, top, width, height };
}

export function defaultMiniNoteRect(index: number, count: number, bounds: MiniNoteBounds): MiniNoteRect {
  const width = Math.min(280, Math.max(0, (bounds.width - 16 - (count - 1) * 8) / count));
  const height = Math.min(220, bounds.height * .42);
  return clampMiniNoteRect({ left: bounds.left + 8 + index * (width + 8),
    top: bounds.top + bounds.height - 8 - height, width, height }, bounds);
}

/** Find room for the new window while every existing window stays in place. */
export function firstFreeMiniNoteRect(bounds: MiniNoteBounds, occupied: readonly MiniNoteRect[]): MiniNoteRect {
  const preferred = defaultMiniNoteRect(0, 1, bounds);
  const gap = 8;
  let best = preferred;
  let bestOverlap = Infinity;
  for (const size of [preferred, clampMiniNoteRect({ ...preferred, width: 180, height: 120 }, bounds)]) {
    const xs = [bounds.left + gap, bounds.left + bounds.width - gap - size.width,
      ...occupied.flatMap(rect => [rect.left - gap - size.width, rect.left + rect.width + gap])];
    const ys = [bounds.top + bounds.height - gap - size.height, bounds.top + gap,
      ...occupied.flatMap(rect => [rect.top - gap - size.height, rect.top + rect.height + gap])];
    const candidates = xs.flatMap(left => ys.map(top => clampMiniNoteRect({ ...size, left, top }, bounds)))
      .sort((a, b) => b.top - a.top || a.left - b.left);
    for (const candidate of candidates) {
      const overlap = occupied.reduce((total, rect) => total +
        Math.max(0, Math.min(candidate.left + candidate.width, rect.left + rect.width + gap) - Math.max(candidate.left, rect.left - gap)) *
        Math.max(0, Math.min(candidate.top + candidate.height, rect.top + rect.height + gap) - Math.max(candidate.top, rect.top - gap)), 0);
      if (overlap === 0) return candidate;
      if (overlap < bestOverlap) { best = candidate; bestOverlap = overlap; }
    }
  }
  // Small panes may have no clear slot; only the incoming window compromises.
  return best;
}

export function resizeMiniNoteRect(rect: MiniNoteRect, dx: number, dy: number, bounds: MiniNoteBounds): MiniNoteRect {
  return clampMiniNoteRect({ ...rect,
    width: Math.min(rect.width + dx, bounds.left + bounds.width - 8 - rect.left),
    height: Math.min(rect.height + dy, bounds.top + bounds.height - 8 - rect.top),
  }, bounds);
}

/** Keep restore requests until the destination workspace finishes loading. */
export const MINI_NOTE_RESTORE_EVENT = "lc-mini-note-restore";
const pendingRestores = new Map<string, FootnoteNoteRef>();
export function requestMiniNoteRestore(ref: FootnoteNoteRef): void {
  pendingRestores.set(ref.docId, { ...ref });
  window.dispatchEvent(new Event(MINI_NOTE_RESTORE_EVENT));
}
export function takeMiniNoteRestore(docId: string): FootnoteNoteRef | undefined {
  const ref = pendingRestores.get(docId);
  if (ref) pendingRestores.delete(docId);
  return ref;
}
