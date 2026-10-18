/**
 * Undo / redo for the footnote panel.
 *
 * The panel does not route every edit through one place: notes and links go
 * through `onChange`, underlines drawn on the page arrive from the workspace,
 * and a ChatBot answer can land while the panel is open. So history watches
 * the footnote itself: each time it changes, the version before is kept, and
 * undo puts it back. Quick changes in a row (typing, dragging a color) count
 * as one step.
 *
 * Two things are not footnote fields and are handled apart:
 * - Workspace links are edges in the link graph; unlinking one is recorded as
 *   its own step, and undo links it again.
 * - Scratch whiteboards are left as they are: deleting one drops its drawing,
 *   so bringing back only the pointer would open an empty board.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { DocFootnote } from "../util/docFootnotes";
import { bookWireRecord } from "../util/bookWireRecord";
import { canonicalJson, normalizeRecord } from "../util/syncContent";

export type HistoryStep =
  | { kind: "footnote"; before: DocFootnote; after: DocFootnote; at: number }
  | { kind: "unlink"; edgeId: string };

/** Changes closer together than this are one step. */
export const HISTORY_COALESCE_MS = 900;
const HISTORY_LIMIT = 50;

/** A footnote as undo sees it: whiteboards and the edit stamp left out. */
export function historyKey(footnote: DocFootnote): string {
  const { whiteboards: _boards, updatedAt: _stamp, ...rest } = footnote;
  return canonicalJson(normalizeRecord(bookWireRecord({ footnotes: [rest] })));
}

export interface FootnoteHistoryOptions {
  footnote: DocFootnote;
  onChange: (next: DocFootnote) => void;
  onRemoveLink?: (edgeId: string) => void;
  /** Absent when links cannot be restored; unlinks are then not recorded. */
  onRestoreLink?: (edgeId: string) => void;
  now?: () => number;
}

export function useFootnoteHistory({ footnote, onChange, onRemoveLink, onRestoreLink, now = Date.now }: FootnoteHistoryOptions) {
  const [stacks, setStacks] = useState<{ undo: HistoryStep[]; redo: HistoryStep[] }>({ undo: [], redo: [] });
  const stacksRef = useRef(stacks);
  stacksRef.current = stacks;
  const previous = useRef(footnote);
  const current = useRef(footnote);
  current.current = footnote;
  /** The key our own undo/redo will produce, so it is not recorded as a new edit. */
  const expected = useRef<string | null>(null);
  /** After an undo, redo or unlink the next edit starts its own step. */
  const sealed = useRef(false);

  useEffect(() => {
    const before = previous.current;
    previous.current = footnote;
    if (before.id !== footnote.id) {
      expected.current = null;
      setStacks({ undo: [], redo: [] });
      return;
    }
    const key = historyKey(footnote);
    if (key === historyKey(before)) return;
    if (expected.current === key) {
      expected.current = null;
      return;
    }
    expected.current = null;
    const at = now();
    const fresh = sealed.current;
    sealed.current = false;
    setStacks(({ undo }) => {
      const last = undo[undo.length - 1];
      if (!fresh && last?.kind === "footnote" && at - last.at < HISTORY_COALESCE_MS) {
        return { undo: [...undo.slice(0, -1), { ...last, after: footnote, at }], redo: [] };
      }
      return { undo: [...undo, { kind: "footnote" as const, before, after: footnote, at }].slice(-HISTORY_LIMIT), redo: [] };
    });
  }, [footnote, now]);

  const restore = useCallback((target: DocFootnote) => {
    const live = current.current;
    const next: DocFootnote = { ...target, whiteboards: live.whiteboards ?? [], updatedAt: now() };
    expected.current = historyKey(next);
    sealed.current = true;
    onChange(next);
  }, [now, onChange]);

  const undo = useCallback(() => {
    const { undo: past, redo: future } = stacksRef.current;
    const step = past[past.length - 1];
    if (!step) return;
    if (step.kind === "footnote") restore(step.before);
    else onRestoreLink?.(step.edgeId);
    sealed.current = true;
    setStacks({ undo: past.slice(0, -1), redo: [...future, step] });
  }, [onRestoreLink, restore]);

  const redo = useCallback(() => {
    const { undo: past, redo: future } = stacksRef.current;
    const step = future[future.length - 1];
    if (!step) return;
    if (step.kind === "footnote") restore(step.after);
    else onRemoveLink?.(step.edgeId);
    sealed.current = true;
    setStacks({ undo: [...past, step], redo: future.slice(0, -1) });
  }, [onRemoveLink, restore]);

  /** Unlink a workspace link as an undoable step. */
  const removeLink = useCallback((edgeId: string) => {
    onRemoveLink?.(edgeId);
    if (!onRestoreLink) return;
    sealed.current = true;
    setStacks(({ undo: past }) => ({ undo: [...past, { kind: "unlink" as const, edgeId }].slice(-HISTORY_LIMIT), redo: [] }));
  }, [onRemoveLink, onRestoreLink]);

  return {
    canUndo: stacks.undo.length > 0,
    canRedo: stacks.redo.length > 0,
    undo,
    redo,
    removeLink,
  };
}
