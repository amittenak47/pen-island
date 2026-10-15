import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { AgentChatMessage } from "./AgentSidePanel";
import type { ArtifactRef } from "../util/padArtifacts";
import { ArtifactCards } from "./ArtifactCards";
import {
  freshNoteId,
  type DocFootnote,
  type DocFootnoteNote,
  type DocFootnoteSubMarkKind,
  type DocFootnoteUserLink,
} from "../util/docFootnotes";
import { ColorRadial } from "../canvas/ColorRadial";
import { HoldButton } from "../components/HoldButton";
import { HighlighterIcon, PenToolIcon, UnderlineIcon } from "../components/MarkToolIcons";
import { ExpandNoteIcon, PictureInPictureIcon } from "../components/NoteWindowIcons";
import { FootnoteMiniNotes, MINI_NOTE_LIMIT, openMiniNote, type MiniNoteRef } from "./FootnoteMiniNotes";
import { isDocChromeTarget, pointerInSubMark } from "../canvas/docSelectionGesture";
import { copyTextToClipboard } from "../util/clipboard";
import { loadInkHandedness } from "../util/inkHandedness";
import {
  normalizePalette,
  paletteForMarkIndex,
  remapColorToPalette,
  stepFallbackPalette,
} from "../util/inkPaletteHistory";
import { footnoteThemeVars } from "../util/footnoteTheme";
import { fitTextareaHeight } from "../util/fitTextareaHeight";
import { normalizeExternalUrl } from "../util/openExternal";
import {
  hasUsableViewportBox,
  liveFootnoteAnchorRect,
  subscribePageSurfaceMove,
  viewportBoxesOverlap,
} from "./sheetAnchor";
import { HOLD_SENSITIVE_MS } from "../util/gesture";
import { useFootnoteHistory } from "./footnoteHistory";
import { pickPhotos } from "../util/photoAttach";
import { ALL_NOTES_ID, NOTE_IMAGE_LIMIT, chipTitle, combinedNote, fieldChip, noteById, noteIsAi, subMarkText } from "../util/docFootnotes";
import { loadNotesCombined, saveNotesCombined } from "../util/notesCombinedPref";
export interface FootnoteOverviewProps {
  onOpenArtifact?: (ref: ArtifactRef) => void;
  onManageArtifacts?: () => void;
  footnote: DocFootnote;
  number?: number;
  displayTheme?: { color: string; palette: readonly string[] };
  onOpenMiniNote?: (noteId: string) => void;
  onOpenFullNote?: (noteId: string) => void;
  openMiniNoteIds?: readonly string[];
  miniNoteCount?: number;
  /** A background assistant app's progress or failure for this pending mark. */
  pendingStatus?: string;
  /** The turns of one saved thread — the card asks per thread, as it opens them. */
  threadMessages: (rootId: string) => AgentChatMessage[];
  availableThreads?: readonly {rootId: string; title: string}[];
  onClose: () => void;
  onChange: (next: DocFootnote) => void;
  /** `null` starts a new thread; a rootId continues that one. */
  onSendCoach: (text: string, threadRootId: string | null) => void;
  /** Queue this mark onto the main coach composer. */
  onAttachCoach?: (footnoteId: string) => void;
  /**
   * Open a saved thread in the agent sheet, not the mark's mini chat.
   *
   * Absent on the conflict split, which still uses the in-card thread.
   */
  onOpenCoachThread?: (rootId: string) => void;
  onOpenExternal: (url: string) => void;
  anchorRect?: DOMRect | null;
  subMarkMode: DocFootnoteSubMarkKind | null;
  onSubMarkModeChange: (mode: DocFootnoteSubMarkKind | null) => void;
  /** Open directly into a saved coach thread from the mark hub. */
  openThreadRootId?: string | null;
  /** Hub-row hover — page paints that sub-mark's span. */
  onHoverSubMark?: (id: string | null) => void;
  /**
   * Underline tool on: the hub wheel paints this theme, not the panel's.
   * Null until the first seed after arming.
   */
  subMarkPaintTheme?: { color: string; palette: string[] } | null;
  onSubMarkPaintTheme?: (theme: { color: string; palette: string[] }) => void;
  /** Committed underline the wheel currently retints. Null = live / next line. */
  activeSubMarkId?: string | null;
  onActiveSubMarkIdChange?: (id: string | null) => void;
  /**
   * Links to other workspaces, as opposed to the external URLs above.
   *
   * Kept as a separate list on purpose: "link to my DP notebook" is not a
   * `https://`, and stuffing it into one would mean either a fake URL scheme
   * or a list where half the rows do not open in a browser.
   */
  workspaceLinks?: ReadonlyArray<{ edgeId: string; title: string; kindLabel: string }>;
  onAddWorkspaceLink?: () => void;
  onOpenWorkspaceLink?: (edgeId: string) => void;
  onRemoveWorkspaceLink?: (edgeId: string) => void;
  /** Link an unlinked workspace link again (the panel's Undo). */
  onRestoreWorkspaceLink?: (edgeId: string) => void;
  /** Open a footnote-owned scratch board on this annotate tab. */
  onOpenWhiteboard?: (id: string) => void;
  /** The owner persists the new scene before publishing its pointer. */
  onCreateWhiteboard?: () => void;
  /** Drop the KV blob after the pointer is gone. */
  onDeleteWhiteboard?: (id: string) => void;
  /**
   * Show what this mark holds; change none of it.
   *
   * The conflict split mounts one of these per pane, on that pane's copy of
   * the mark — so Local's hub and the other device's hub can differ, which is
   * the whole reason a row says "changed on both". Nothing here may write:
   * the reader is choosing between two copies, and Keep is the only write in
   * that flow. Adding a note to a copy that is about to lose would be work
   * thrown away without saying so.
   */
  readOnly?: boolean;
}
type Task =
  | { kind: "note"; id: string | null }
  | { kind: "thread"; rootId: string | null }
  | { kind: "link"; index: number | null };
function turnKind(role: AgentChatMessage["role"]): "user" | "assistant" | "system" | "app" {
  if (role === "user" || role === "system" || role === "app") return role;
  return "assistant";
}
function viewport() {
  const view = window.visualViewport;
  return {
    width: view?.width ?? window.innerWidth,
    height: view?.height ?? window.innerHeight,
    originX: view?.offsetLeft ?? 0,
    originY: view?.offsetTop ?? 0,
  };
}
/** Elements whose box is "the paper", in the order we would rather have one. */
/*
 * The paper the card is kept over.
 *
 * The conflict pane is on this list because two of these cards can be open at
 * once there — one per side, each on its own copy of the same mark. Without a
 * pane to narrow to, both clamp to the same viewport box and land on top of
 * each other, which is the one arrangement that makes comparing them useless.
 */
const PAPER_SELECTORS = [
  ".lc-page-content-slot",
  ".lc-page-marks-slot",
  ".lc-hub-conflict-preview",
] as const;

function boxHolds(box: DOMRect, x: number, y: number): boolean {
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

/**
 * The box the card is allowed to sit in.
 *
 * The pane, horizontally narrowed to the paper. A split pane is barely wider
 * than the page it holds, so clamping to the pane looked correct there and
 * hid what the rule actually says — on a full-screen 4K window the same pane
 * is most of a metre of empty desk either side of a reading column, and a card
 * centred in *that* lands nowhere near the mark it belongs to. The page is what
 * the reader is looking at, so the page is what the card is placed against.
 *
 * Vertically it stays the pane's: a document is taller than the window, and
 * clamping to the paper's full height would let the card settle off-screen.
 */
function paneBox(anchorRect: DOMRect | null | undefined): DOMRect {
  let pane: DOMRect | null = null;
  if (anchorRect) {
    const cx = anchorRect.left + anchorRect.width / 2;
    const cy = anchorRect.top + anchorRect.height / 2;
    for (const board of document.querySelectorAll(".lc-board")) {
      const box = board.getBoundingClientRect();
      if (boxHolds(box, cx, cy)) {
        pane = box;
        break;
      }
    }
  }
  if (!pane) {
    const view = viewport();
    pane = new DOMRect(view.originX, view.originY, view.width, view.height);
  }
  if (!anchorRect) return pane;
  const cx = anchorRect.left + anchorRect.width / 2;
  const cy = anchorRect.top + anchorRect.height / 2;
  for (const selector of PAPER_SELECTORS) {
    for (const node of document.querySelectorAll(selector)) {
      const paper = node.getBoundingClientRect();
      if (paper.width <= 1 || !boxHolds(paper, cx, cy)) continue;
      const left = Math.max(pane.left, paper.left);
      const right = Math.min(pane.right, paper.right);
      if (right - left < 120) continue;
      return new DOMRect(left, pane.top, right - left, pane.height);
    }
  }
  return pane;
}
function settle(node: HTMLElement, left: number, top: number, bounds: DOMRect) {
  const margin = 8;
  const maxLeft = Math.max(bounds.left + margin, bounds.right - node.offsetWidth - margin);
  const maxTop = Math.max(bounds.top + margin, bounds.bottom - node.offsetHeight - margin);
  node.style.left = `${Math.round(Math.min(Math.max(bounds.left + margin, left), maxLeft))}px`;
  node.style.top = `${Math.round(Math.min(Math.max(bounds.top + margin, top), maxTop))}px`;
  node.style.visibility = "visible";
}
function clampPanel(node: HTMLElement, anchorRect: DOMRect | null | undefined) {
  const margin = 8;
  const pane = paneBox(anchorRect);
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  let left: number;
  let top: number;
  if (anchorRect) {
    left = anchorRect.left + anchorRect.width / 2 - width / 2;
    /*
     * Below the mark, above it, or level with it — in that order.
     *
     * The old rule had only the first two, and a tall card fits neither: below
     * runs off the bottom, so it flipped to above, which runs off the top, and
     * `settle` then clamped it to the top of the pane. In a split that is a few
     * pixels of travel and reads as "just above the mark". Full-screen it is the
     * top of a 4K window — the card left the page entirely and parked in the
     * dark margin, which is what makes it look like it belongs to nothing.
     *
     * Level with the mark is the honest third answer: the card cannot be clear
     * of it, so it is centred on it and stays beside the words it is about.
     */
    const below = anchorRect.bottom + 6;
    const above = anchorRect.top - height - 6;
    if (below + height + margin <= pane.bottom) {
      top = below;
    } else if (above >= pane.top + margin) {
      top = above;
    } else {
      /*
       * Beside the mark rather than over it.
       *
       * Level with the mark used to mean *on* it: the card was centred on the
       * anchor in both directions, so a quote too tall to clear vertically got
       * its own words covered by the card that is about them. A reading column
       * does not fill the pane — there is a margin either side of it on every
       * screen this runs on — so the card goes into that gutter first, and only
       * lands on the words when there is nowhere either side to put it.
       */
      const rightOf = anchorRect.right + 6;
      const leftOf = anchorRect.left - width - 6;
      if (rightOf + width + margin <= pane.right) left = rightOf;
      else if (leftOf >= pane.left + margin) left = leftOf;
      top = anchorRect.top + anchorRect.height / 2 - height / 2;
    }
  } else {
    left = pane.left + pane.width / 2 - width / 2;
    top = pane.top + pane.height / 2 - height / 2;
  }
  settle(node, left, top, pane);
}
/**
 * The size the reader last dragged the panel to, kept for the session.
 *
 * Position is not kept: the panel should open beside the mark it is about,
 * which is somewhere else each time. A size is a preference about the panel.
 */
let preferredPanelSize: { width: number; height: number } | null = null;
const PANEL_MIN = { width: 220, height: 160 };

/** Whether a press on `target` may start a panel drag, rather than use a control. */
function startsPanelDrag(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".lc-footnote-panel-grip")) return true;
  if (!target.closest(".lc-footnote-overview-toolbar, .lc-footnote-overview-title-display")) return false;
  return !target.closest(
    "button:not(.lc-footnote-overview-title-display), input, textarea, select, a, [contenteditable='true'], .lc-footnote-overview-color, .lc-hold-reveal",
  );
}

function applyViewportSize(node: HTMLElement, task: Task | null, compact = false, bounds?: DOMRect) {
  const margin = 16;
  const { width, height } = viewport();
  node.style.setProperty("--lc-vvh", `${Math.round(height)}px`);
  node.style.setProperty("--lc-vvw", `${Math.round(width)}px`);
  const maxH = Math.round(height - margin * 2);
  const maxW = Math.min(280, Math.round(width - margin * 2), bounds ? bounds.width - 16 : width);
  node.style.maxWidth = `${maxW}px`;
  node.style.width = "";
  node.style.height = "";
  if (task?.kind === "thread") {
    node.style.maxHeight = `${Math.min(Math.round(height * 0.62), maxH, 520)}px`;
  } else if (task) {
    node.style.maxHeight = `${Math.min(320, maxH)}px`;
  } else if (compact) {
    node.style.maxHeight = `${Math.min(132, maxH)}px`;
  } else {
    node.style.maxHeight = `${Math.min(Math.round(height * 0.78), maxH, 600)}px`;
  }
}

/** Hub heading: looks like a title until double-click opens a field. */
function MarkTitle({
  value,
  onCommit,
  readOnly = false,
}: {
  value: string | undefined;
  onCommit: (next: string | undefined) => void;
  /** Show the title; do not offer to rename it. */
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const labeled = value?.replace(/\s+/g, " ").trim() ?? "";

  useLayoutEffect(() => {
    if (!editing) return;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    node.select();
  }, [editing]);

  const commit = () => {
    const next = draft.replace(/\s+/g, " ").trim();
    onCommit(next.length > 0 ? next : undefined);
    setEditing(false);
  };

  if (editing && !readOnly) {
    return (
      <input
        ref={inputRef}
        className="lc-footnote-overview-title is-editing"
        value={draft}
        placeholder="Title"
        aria-label="Mark title"
        maxLength={80}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value ?? "");
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={`lc-footnote-overview-title-display${labeled ? "" : " is-empty"}`}
      aria-label={
        readOnly
          ? "Mark title"
          : labeled
            ? "Mark title, double-click to edit"
            : "Add title, double-click to edit"
      }
      title={readOnly ? undefined : "Double-click to edit title"}
      onDoubleClick={
        readOnly
          ? undefined
          : (event) => {
              event.preventDefault();
              setDraft(value ?? "");
              setEditing(true);
            }
      }
    >
      {labeled || "Title"}
    </button>
  );
}
/**
 * Footnote overview — doc-sheet chrome, user links only.
 *
 * Chat lives on the agent sheet. The 💬 control and a thread row hand off to
 * {@link onOpenCoachThread} / {@link onAttachCoach} and this card closes.
 */
export function FootnoteOverview({
  onOpenArtifact,
  onManageArtifacts,
  footnote,
  number: footnoteNumber,
  displayTheme,
  onOpenMiniNote,
  onOpenFullNote,
  openMiniNoteIds = [],
  miniNoteCount = 0,
  pendingStatus,
  threadMessages,
  availableThreads = [],
  onClose,
  onChange,
  onSendCoach,
  onAttachCoach,
  onOpenCoachThread,
  onOpenExternal,
  workspaceLinks = [],
  onAddWorkspaceLink,
  onOpenWorkspaceLink,
  onRemoveWorkspaceLink,
  onRestoreWorkspaceLink,
  onOpenWhiteboard,
  onCreateWhiteboard,
  onDeleteWhiteboard,
  readOnly = false,
  anchorRect,
  subMarkMode,
  onSubMarkModeChange,
  openThreadRootId = null,
  onHoverSubMark,
  subMarkPaintTheme = null,
  onSubMarkPaintTheme,
  activeSubMarkId = null,
  onActiveSubMarkIdChange,
}: FootnoteOverviewProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** Where the reader dragged the panel; null while it follows its mark. */
  const userPlace = useRef<{ left: number; top: number } | null>(null);
  const panelGesture = useRef<{
    mode: "move" | "resize"; pointerId: number; x: number; y: number;
    left: number; top: number; width: number; height: number; moved: boolean;
  } | null>(null);
  /** Swallow the click that ends a drag started on the title. */
  const swallowClick = useRef(false);
  /** The next frame's placement while the panel is dragged or resized. */
  const placeFrame = useRef(0);
  // A different mark opens beside its own words, not where the last one was dragged.
  useEffect(() => { userPlace.current = null; }, [footnote.id]);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [draft, setDraft] = useState("");
  const [localMiniNotes, setLocalMiniNotes] = useState<MiniNoteRef[]>([]);
  const palette =
    normalizePalette(displayTheme?.palette ?? footnote.palette) ?? paletteForMarkIndex((footnoteNumber ?? 1) - 1);
  const handedness = loadInkHandedness();
  const markColor = displayTheme?.color ?? footnote.color ?? palette[0] ?? "#0d9488";
  const userLinks = footnote.userLinks ?? [];
  const notes = footnote.notes ?? [];
  const whiteboards = footnote.whiteboards ?? [];
  const threads = footnote.threads ?? [];
  const subMarks = footnote.subMarks ?? [];
  // Completed ChatBot marks accept the same manual notes as other marks.
  const isAiTab = footnote.kind === "ai";
  const rowsAreReadOnly = readOnly;
  const searchLink =
    footnote.kind === "search" && footnote.url
      ? { title: footnote.query || "Search", url: footnote.url }
      : null;
  const [copied, setCopied] = useState(false);
  const footnoteRef = useRef(footnote);
  footnoteRef.current = footnote;
  const history = useFootnoteHistory({
    footnote,
    onChange,
    onRemoveLink: onRemoveWorkspaceLink,
    onRestoreLink: onRestoreWorkspaceLink,
  });

  const persistMarkPalette = (nextPalette: string[], nextColor: string) => {
    const current = footnoteRef.current;
    onChange({ ...current, palette: nextPalette, color: nextColor });
  };
  // Underline or highlight armed: the wheel paints the new sub-mark, not the footnote.
  const underlineArmed = subMarkMode === "underline" || subMarkMode === "highlight";
  const wheelPalette = underlineArmed
    ? (subMarkPaintTheme?.palette ?? stepFallbackPalette(palette, 1))
    : palette;
  const wheelColor = underlineArmed
    ? (subMarkPaintTheme?.color ?? wheelPalette[0] ?? "#0d9488")
    : markColor;
  const persistWheel = (nextPalette: string[], nextColor: string) => {
    if (underlineArmed) {
      onSubMarkPaintTheme?.({ palette: nextPalette, color: nextColor });
      if (activeSubMarkId) {
        const current = footnoteRef.current;
        onChange({
          ...current,
          subMarks: (current.subMarks ?? []).map((mark) =>
            mark.id === activeSubMarkId
              ? { ...mark, palette: nextPalette, color: nextColor }
              : mark,
          ),
        });
      }
      return;
    }
    persistMarkPalette(nextPalette, nextColor);
  };
  const cycleMarkPalette = (delta: 1 | -1) => {
    const next = stepFallbackPalette(wheelPalette, delta);
    persistWheel(next, remapColorToPalette(wheelColor, wheelPalette, next));
  };

  const prevSubMarkModeRef = useRef<DocFootnoteSubMarkKind | null>(null);
  useEffect(() => {
    const prev = prevSubMarkModeRef.current;
    prevSubMarkModeRef.current = subMarkMode;
    if (!subMarkMode || prev === subMarkMode) return;
    const next = stepFallbackPalette(palette, 1);
    onSubMarkPaintTheme?.({ palette: next, color: next[0] ?? "#0d9488" });
    onActiveSubMarkIdChange?.(null);
  }, [subMarkMode, palette, onSubMarkPaintTheme, onActiveSubMarkIdChange]);

  useLayoutEffect(() => {
    if (task?.kind !== "thread") return;
    const node = replyRef.current;
    if (!node) return;
    fitTextareaHeight(node);
  }, [draft, task]);

  useEffect(() => {
    if (!openThreadRootId) return;
    setTask({ kind: "thread", rootId: openThreadRootId });
  }, [openThreadRootId]);

  useEffect(() => () => onHoverSubMark?.(null), [onHoverSubMark]);

  const hasPanelContent =
    userLinks.length > 0 ||
    notes.length > 0 ||
    threads.length > 0 ||
    subMarks.length > 0;

  const clearPanelContent = () => {
    const current = footnoteRef.current;
    onChange({
      ...current,
      userLinks: undefined,
      notes: undefined,
      threads: undefined,
      subMarks: undefined,
      ...(current.threadRootId ? { threadRootId: undefined } : {}),
    });
    setTask(null);
    setDraft("");
    if (subMarkMode) onSubMarkModeChange(null);
  };

  // Let the page receive pointers so the reader can select inside the mark.
  // Close when the down is outside the panel and outside the mark bands.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (isDocChromeTarget(event.target)) return;
      if (event.target instanceof Element && event.target.closest(".lc-footnote-mini-tray")) return;
      if (pointerInSubMark(event.clientX, event.clientY)) return;
      if (task) {
        setTask(null);
        return;
      }
      onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose, task]);

  const copyMarkText = useCallback(async () => {
    const live = window.getSelection()?.toString().trim() ?? "";
    const text =
      live ||
      footnote.blockText?.trim() ||
      footnote.excerpt?.trim() ||
      "";
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  }, [footnote.blockText, footnote.excerpt]);

  const place = useCallback(() => {
    const node = panelRef.current;
    if (!node) return;
    const live = liveFootnoteAnchorRect(footnote.id, anchorRect) ?? anchorRect ?? null;
    const bounds = paneBox(live);
    applyViewportSize(node, task, false, bounds);
    if (preferredPanelSize && task?.kind !== "thread") {
      const view = viewport();
      node.style.maxWidth = "none";
      node.style.maxHeight = `${Math.round(view.height - 16)}px`;
      node.style.width = `${Math.min(preferredPanelSize.width, Math.round(view.width - 16))}px`;
      node.style.height = `${Math.min(preferredPanelSize.height, Math.round(view.height - 16))}px`;
    }
    if (userPlace.current) {
      // Once dragged, the panel stays where the reader put it.
      const view = viewport();
      settle(node, userPlace.current.left, userPlace.current.top,
        new DOMRect(view.originX, view.originY, view.width, view.height));
      return;
    }
    if (
      hasUsableViewportBox(live) &&
      live &&
      !viewportBoxesOverlap(live, paneBox(live))
    ) {
      onClose();
      return;
    }
    clampPanel(node, live);
  }, [anchorRect, footnote.id, onClose, task]);
  const beginPanelGesture = useCallback((event: ReactPointerEvent<HTMLElement>, mode: "move" | "resize") => {
    const node = panelRef.current;
    if (!node || event.button > 0) return;
    if (mode === "move" && !startsPanelDrag(event.target)) return;
    const box = node.getBoundingClientRect();
    panelGesture.current = {
      mode, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      left: box.left, top: box.top, width: box.width, height: box.height, moved: false,
    };
    if (mode === "resize") {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  }, []);
  const movePanelGesture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const gesture = panelGesture.current;
    const node = panelRef.current;
    if (!gesture || !node || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.moved) {
      // A tap on the title still edits it; only a real move starts a drag.
      if (gesture.mode === "move" && Math.hypot(dx, dy) < 5) return;
      gesture.moved = true;
      if (gesture.mode === "move") event.currentTarget.setPointerCapture?.(event.pointerId);
      // Its own compositor layer while it moves: a slide, not a repaint of the page under it.
      if (gesture.mode === "move") node.style.willChange = "transform";
    }
    event.preventDefault();
    const view = viewport();
    if (gesture.mode === "move") {
      userPlace.current = { left: gesture.left + dx, top: gesture.top + dy };
    } else {
      preferredPanelSize = {
        width: Math.max(PANEL_MIN.width, Math.min(gesture.width + dx, view.width - 16)),
        height: Math.max(PANEL_MIN.height, Math.min(gesture.height + dy, view.height - 16)),
      };
      userPlace.current = { left: gesture.left, top: gesture.top };
    }
    /*
     * Pens report far more often than the display draws, so paint once a
     * frame, and only what changes. A move slides the card with a transform
     * (no layout at all); a resize sets its size. The full placement, which
     * measures the page to find the mark, runs once on release: run per frame
     * it forced the whole document's layout and dropped half the frames.
     */
    if (!placeFrame.current) {
      placeFrame.current = requestAnimationFrame(() => {
        placeFrame.current = 0;
        const live = panelGesture.current;
        const card = panelRef.current;
        if (!live || !card) return;
        const frame = viewport();
        if (live.mode === "move" && userPlace.current) {
          const left = Math.min(Math.max(frame.originX + 8, userPlace.current.left), frame.originX + frame.width - live.width - 8);
          const top = Math.min(Math.max(frame.originY + 8, userPlace.current.top), frame.originY + frame.height - live.height - 8);
          card.style.transform = `translate(${Math.round(left - live.left)}px, ${Math.round(top - live.top)}px)`;
        } else if (live.mode === "resize" && preferredPanelSize) {
          card.style.maxWidth = "none";
          card.style.maxHeight = `${Math.round(frame.height - 16)}px`;
          card.style.width = `${Math.round(preferredPanelSize.width)}px`;
          card.style.height = `${Math.round(preferredPanelSize.height)}px`;
        }
      });
    }
  }, []);
  const endPanelGesture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const gesture = panelGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    panelGesture.current = null;
    if (placeFrame.current) {
      cancelAnimationFrame(placeFrame.current);
      placeFrame.current = 0;
    }
    if (gesture.moved) {
      if (panelRef.current) {
        panelRef.current.style.transform = "";
        panelRef.current.style.willChange = "";
      }
      place();
    }
    if (gesture.moved && gesture.mode === "move") swallowClick.current = true;
  }, [place]);
  const nudgePanelSize = useCallback((dx: number, dy: number) => {
    const node = panelRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    const view = viewport();
    preferredPanelSize = {
      width: Math.max(PANEL_MIN.width, Math.min(box.width + dx, view.width - 16)),
      height: Math.max(PANEL_MIN.height, Math.min(box.height + dy, view.height - 16)),
    };
    userPlace.current = { left: box.left, top: box.top };
    place();
  }, [place]);
  useLayoutEffect(() => {
    place();
    const node = panelRef.current;
    const stopSurface = subscribePageSurfaceMove(place);
    const observer =
      node && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => place())
        : null;
    if (node && observer) observer.observe(node);
    return () => {
      observer?.disconnect();
      stopSurface();
    };
  }, [place, task, notes.length, whiteboards.length, threads.length, userLinks.length, subMarks.length]);
  const openThreadMessages = useMemo(
    () => (task?.kind === "thread" && task.rootId ? threadMessages(task.rootId) : []),
    [task, threadMessages],
  );
  useLayoutEffect(() => {
    const node = transcriptRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [openThreadMessages]);
  const updateNotes = (next: DocFootnoteNote[]) => {
    onChange({ ...footnote, notes: next.length > 0 ? next : undefined });
  };
  const updateWhiteboards = (next: typeof whiteboards) => {
    onChange({ ...footnote, whiteboards: next.length > 0 ? next : undefined });
  };
  const removeWhiteboard = (id: string) => {
    updateWhiteboards(whiteboards.filter((entry) => entry.id !== id));
    onDeleteWhiteboard?.(id);
  };
  const saveNote = (text: string, images: string[]) => {
    if (task?.kind !== "note") return;
    const body = text.trim();
    const now = Date.now();
    // A note may be words, pictures or both; with neither it is gone.
    if (!body && images.length === 0) {
      if (task.id) updateNotes(notes.filter((note) => note.id !== task.id));
      setTask(null);
      return;
    }
    const pictures = images.length > 0 ? images : undefined;
    if (task.id) {
      updateNotes(
        notes.map((note) =>
          note.id === task.id ? { ...note, text: body, images: pictures, updatedAt: now } : note,
        ),
      );
    } else {
      updateNotes([
        ...notes,
        { id: freshNoteId(notes, now), text: body, images: pictures, by: "reader", createdAt: now, updatedAt: now },
      ]);
    }
    setTask(null);
  };
  const updateUserLinks = (next: DocFootnoteUserLink[]) => {
    onChange({ ...footnote, userLinks: next.length > 0 ? next : undefined });
  };
  const saveLink = (url: string, title?: string) => {
    if (task?.kind !== "link") return;
    const trimmed = normalizeExternalUrl(url);
    if (!trimmed) return;
    const entry: DocFootnoteUserLink = title?.trim()
      ? { url: trimmed, title: title.trim() }
      : { url: trimmed };
    if (task.index != null) {
      updateUserLinks(userLinks.map((link, i) => (i === task.index ? entry : link)));
    } else {
      updateUserLinks([...userLinks, entry]);
    }
    setTask(null);
  };
  const removeUserLink = (index: number) => {
    updateUserLinks(userLinks.filter((_, i) => i !== index));
    if (task?.kind === "link" && task.index === index) setTask(null);
  };
  const removeThread = (rootId: string) => {
    const next = threads.filter((thread) => thread.rootId !== rootId);
    onChange({
      ...footnote,
      threads: next.length > 0 ? next : undefined,
      ...(footnote.threadRootId === rootId ? { threadRootId: next[0]?.rootId } : {}),
    });
    if (task?.kind === "thread" && task.rootId === rootId) setTask(null);
  };
  const send = () => {
    if (task?.kind !== "thread" || !task.rootId) return;
    const text = draft.trim();
    if (!text) return;
    onSendCoach(text, task.rootId);
    setDraft("");
  };
  const openTask = (next: Task) => {
    setDraft("");
    if (subMarkMode) onSubMarkModeChange(null);
    setTask(next);
  };
  const removeSubMark = (id: string) => {
    onHoverSubMark?.(null);
    if (activeSubMarkId === id) onActiveSubMarkIdChange?.(null);
    const next = subMarks.filter((mark) => mark.id !== id);
    onChange({ ...footnote, subMarks: next.length > 0 ? next : undefined });
  };
  const selectSubMark = (mark: (typeof subMarks)[number]) => {
    if (!underlineArmed) return;
    const nextPalette =
      normalizePalette(mark.palette) ?? subMarkPaintTheme?.palette ?? stepFallbackPalette(palette, 1);
    const nextColor = mark.color ?? nextPalette[0] ?? "#0d9488";
    onActiveSubMarkIdChange?.(mark.id);
    onSubMarkPaintTheme?.({ palette: nextPalette, color: nextColor });
  };
  const editingNote =
    task?.kind === "note" ? notes.find((note) => note.id === task.id) ?? null : null;
  const editingLink =
    task?.kind === "link" && task.index != null ? userLinks[task.index] ?? null : null;
  const tint = footnoteThemeVars(markColor, palette);
  const localMiniEntries = localMiniNotes.flatMap(ref => {
    const found = noteById(footnote, ref.noteId);
    return ref.footnoteId === footnote.id && found ? [{ ...ref, note: found.note, footnote,
      number: footnoteNumber, noteNumber: found.number,
      theme: { color: markColor, palette } }] : [];
  });
  const [notesCombined, setNotesCombined] = useState(loadNotesCombined);
  const allNotes = notesCombined ? combinedNote(footnote) : null;
  const activeMiniIds = onOpenMiniNote ? openMiniNoteIds : localMiniEntries.map(entry => entry.noteId);
  const activeMiniCount = onOpenMiniNote ? miniNoteCount : localMiniEntries.length;
  const canOpenMini = (id: string) => activeMiniIds.includes(id) || activeMiniCount < MINI_NOTE_LIMIT;
  const showMini = (id: string) => {
    if (!canOpenMini(id)) return;
    if (onOpenMiniNote) onOpenMiniNote(id);
    else setLocalMiniNotes(current => openMiniNote(current, { footnoteId: footnote.id, noteId: id }));
  };
  const localMiniBounds = useCallback(() => paneBox(anchorRect), [anchorRect]);
  const taskMotion = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] as const },
  };
  const taskClass =
    task?.kind === "thread"
      ? " is-task is-task-thread"
      : task
        ? " is-task is-task-compact"
        : "";
  return createPortal(
    <>
      <button
        type="button"
        className="lc-doc-sheet-backdrop is-pass-through"
        aria-label={task ? "Back to footnote" : "Close footnote"}
        tabIndex={-1}
        style={{ zIndex: 232 }}
      />
      <motion.div
        className={`lc-doc-sheet lc-footnote-overview${taskClass}${isAiTab && !footnote.pending ? " is-chatbot-complete" : ""}`}
        ref={panelRef}
        role="dialog"
        aria-label={
          task?.kind === "note"
            ? "Note"
            : task?.kind === "link"
              ? "Link"
            : task?.kind === "thread"
              ? "Thread"
              : footnoteNumber != null
                ? `Footnote ${footnoteNumber}`
                : "Footnote"
        }
        onKeyDown={event => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if (task) setTask(null);
          else onClose();
        }}
        style={{ visibility: "hidden", zIndex: 233, ...tint }}
        onPointerDown={event => beginPanelGesture(event, "move")}
        onPointerMove={movePanelGesture}
        onPointerUp={endPanelGesture}
        onPointerCancel={endPanelGesture}
        onClickCapture={event => {
          if (!swallowClick.current) return;
          swallowClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <span className="lc-footnote-panel-grip" aria-hidden title="Drag to move" />
        <AnimatePresence mode="wait" initial={false}>
          {task?.kind === "note" ? (
            <motion.div
              key="task-note"
              className="lc-footnote-overview-task lc-footnote-overview-task-compact"
              {...taskMotion}
            >
              <NoteTask
                key={editingNote?.id ?? "new"}
                initial={editingNote?.text ?? ""}
                initialImages={editingNote?.images ?? []}
                onSave={saveNote}
                onBack={() => setTask(null)}
              />
            </motion.div>
          ) : task?.kind === "link" ? (
            <motion.div
              key="task-link"
              className="lc-footnote-overview-task lc-footnote-overview-task-compact"
              {...taskMotion}
            >
              <LinkTask
                key={editingLink?.url ?? "new"}
                initialUrl={editingLink?.url ?? ""}
                initialTitle={editingLink?.title ?? ""}
                onSave={saveLink}
                onRemove={
                  task.index != null
                    ? () => {
                        removeUserLink(task.index!);
                      }
                    : undefined
                }
                onBack={() => setTask(null)}
              />
            </motion.div>
          ) : task?.kind === "thread" ? (
            <motion.div
              key={`task-thread-${task.rootId ?? "new"}`}
              className="lc-footnote-overview-task lc-footnote-overview-task-thread"
              {...taskMotion}
            >
              <div className="lc-footnote-task-head">
                <button type="button" className="lc-secondary" onClick={() => setTask(null)}>
                  Back
                </button>
                <span className="lc-footnote-task-title">
                  {task.rootId
                    ? threads.find((thread) => thread.rootId === task.rootId)?.title ?? "Thread"
                    : "Thread"}
                </span>
                {task.rootId && (
                  <HoldButton className="lc-secondary lc-hold-danger" label="Unlink thread"
                    ariaLabel="Hold to unlink thread. Conversation stays saved" holdMs={HOLD_SENSITIVE_MS}
                    onConfirm={() => removeThread(task.rootId!)} />
                )}
              </div>
              <div className="lc-agent-messages lc-footnote-overview-thread" ref={transcriptRef}>
                {openThreadMessages.map((message) => (
                  <div
                    key={message.id}
                    className={`lc-agent-turn lc-agent-turn-${turnKind(message.role)}`}
                  >
                    <div className="lc-agent-turn-role">
                      {turnKind(message.role) === "user" ? "You" : "Agent"}
                    </div>
                    <div className="lc-agent-turn-body">
                      {message.content || (message.pending ? "…" : "")}
                    </div>
                  </div>
                ))}
              </div>
              <form
                className="lc-agent-composer lc-footnote-overview-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  send();
                }}
              >
                <div className="lc-agent-composer-field">
                <textarea
                  ref={replyRef}
                  value={draft}
                  rows={3}
                  placeholder="Reply…"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    if (event.shiftKey) return;
                    event.preventDefault();
                    send();
                  }}
                  aria-label="Reply"
                />
                <div className="lc-agent-composer-bar">
                  <div className="lc-agent-composer-actions">
                    <button type="submit" disabled={draft.trim().length === 0} aria-label="Send">
                      <span className="lc-label-long">Send</span>
                      <span className="lc-label-short" aria-hidden>
                        S
                      </span>
                    </button>
                  </div>
                </div>
                </div>
              </form>
            </motion.div>
          ) : (
            <motion.div
              key="hub"
              className="lc-footnote-overview-hub"
              {...taskMotion}
            >
              <MarkTitle
                value={footnote.title}
                readOnly={readOnly}
                onCommit={(title) => onChange({ ...footnoteRef.current, title })}
              />
              <header className="lc-footnote-overview-toolbar" aria-label="Mark style">
                <div className="lc-footnote-submark-modes" role="group" aria-label="Mark actions">
                  {/* Underline and highlight draw on the mark, so they are writes. Copy is not. */}
                  {readOnly ? null : (
                  <button
                    type="button"
                    className={`lc-footnote-mark-tool${subMarkMode === "underline" ? " is-active" : ""}`}
                    aria-label="Underline"
                    title="Underline"
                    aria-pressed={subMarkMode === "underline"}
                    onClick={() =>
                      onSubMarkModeChange(subMarkMode === "underline" ? null : "underline")
                    }
                  >
                    <UnderlineIcon size={16} />
                  </button>
                  )}
                  {readOnly ? null : (
                  <button
                    type="button"
                    className={`lc-footnote-mark-tool${subMarkMode === "highlight" ? " is-active" : ""}`}
                    aria-label="Highlight"
                    title="Highlight"
                    aria-pressed={subMarkMode === "highlight"}
                    onClick={() =>
                      onSubMarkModeChange(subMarkMode === "highlight" ? null : "highlight")
                    }
                  >
                    <HighlighterIcon size={16} />
                  </button>
                  )}
                  <button
                    type="button"
                    className={`lc-footnote-mark-tool lc-footnote-copy-tool${copied ? " is-copied" : ""}`}
                    aria-label={copied ? "Copied" : "Copy"}
                    title={copied ? "Copied" : "Select text in the mark, then copy — or copy the whole mark"}
                    onClick={() => {
                      void copyMarkText();
                    }}
                  >
                    <span aria-hidden>{copied ? "✓" : "📋"}</span>
                  </button>
                  {onAttachCoach && !readOnly && (
                    <button
                      type="button"
                      className="lc-footnote-mark-tool"
                      aria-label="Attach to chat"
                      title="Attach to chat"
                      onClick={() => onAttachCoach(footnote.id)}
                    >
                      <span aria-hidden>💬</span>
                    </button>
                  )}
                </div>
                {/* The wheel retints the mark on this device. Not from here. */}
                <div className="lc-footnote-overview-color" hidden={readOnly}>
                  <ColorRadial
                    colors={wheelPalette}
                    value={wheelColor}
                    onPick={(color) => persistWheel(wheelPalette, color)}
                    onCycleNext={() => cycleMarkPalette(1)}
                    onCyclePrev={() => cycleMarkPalette(-1)}
                    onEditColor={(index, color) => {
                      const next = wheelPalette.map((swatch, i) => (i === index ? color : swatch));
                      const selected =
                        wheelPalette[index]?.trim().toLowerCase() ===
                        wheelColor.trim().toLowerCase();
                      persistWheel(next, selected ? color : wheelColor);
                    }}
                    handedness={handedness}
                    compact
                    wheelZIndex={240}
                  />
                </div>
                {!readOnly && (
                  <div className="lc-footnote-panel-history">
                    {hasPanelContent && (
                      <HoldButton
                        label="Reset"
                        className="lc-footnote-panel-reset"
                        ariaLabel="Hold to reset: removes this footnote's notes, links, chats and underlines"
                        dataTip="Hold to remove notes, links, chats and underlines"
                        onConfirm={clearPanelContent}
                      >
                        <strong>Reset</strong>
                      </HoldButton>
                    )}
                    <div className="lc-footnote-panel-undo-row">
                      <button type="button" className="lc-footnote-panel-mini" aria-label="Undo" data-tip="Undo"
                        disabled={!history.canUndo} onClick={history.undo}>
                        <HistoryArrow />
                      </button>
                      <button type="button" className="lc-footnote-panel-mini is-redo" aria-label="Redo" data-tip="Redo"
                        disabled={!history.canRedo} onClick={history.redo}>
                        <HistoryArrow />
                      </button>
                    </div>
                  </div>
                )}
              </header>
              {subMarks.length > 0 && (
              <HubSection title="Annotations">
                <ul
                  className={listClass(subMarks.length)}
                  aria-label="Sub-marks"
                >
                  {subMarks.map((mark) => {
                    const words = subMarkText(mark.excerpt, footnote.excerpt);
                    return (
                    <li
                      key={mark.id}
                      className={`lc-footnote-overview-link-row${
                        activeSubMarkId === mark.id ? " is-selected" : ""
                      }`}
                      style={
                        mark.color
                          ? footnoteThemeVars(
                              mark.color,
                              normalizePalette(mark.palette) ?? palette,
                            )
                          : undefined
                      }
                      onPointerEnter={() => onHoverSubMark?.(mark.id)}
                      onPointerLeave={() => onHoverSubMark?.(null)}
                    >
                      <button
                        type="button"
                        className="lc-agent-scope-option"
                        aria-label={`${mark.kind === "highlight" ? "Highlight" : "Underline"}: ${words}`}
                        onClick={() => selectSubMark(mark)}
                      >
                        {/* Shown the way the page shows it: underlined or highlighted words. */}
                        <span className="lc-footnote-item-chip" data-type="annotation">
                          <span className={`lc-footnote-annotation-text is-${mark.kind}`}>{chipTitle(words) || words}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="lc-footnote-overview-add lc-footnote-overview-row-remove"
                        aria-label={`Remove ${mark.kind}`}
                        onClick={() => removeSubMark(mark.id)}
                      >
                        ✕
                      </button>
                    </li>
                  );
                  })}
                </ul>
              </HubSection>
              )}
              {(!rowsAreReadOnly || notes.length > 0 || footnote.pending) && (
              <HubSection title="Notes" onAdd={rowsAreReadOnly ? undefined : () => openTask({ kind: "note", id: null })}
                extra={notes.length > 1 ? (
                  <button type="button" role="switch" aria-checked={notesCombined} aria-label="Show the notes as one"
                    title={notesCombined ? "Show each note on its own" : "Show the notes as one"}
                    className={`lc-footnote-notes-combine${notesCombined ? " is-on" : ""}`}
                    onClick={() => { setNotesCombined(!notesCombined); saveNotesCombined(!notesCombined); }}>
                    <CombineIcon />
                  </button>
                ) : null}>
                {footnote.pending ? <p className="lc-muted" role="status">{pendingStatus || "ChatBot is writing..."}</p> : null}
                {allNotes ? (
                  <ul className={listClass(1)}>
                    <NoteRow note={allNotes} index={0} ai={notes.every((note) => noteIsAi(note, footnote))}
                      chip={`All notes (${notes.length})`} name="All notes"
                      readOnly canOpenMini={canOpenMini(ALL_NOTES_ID)} miniOpen={activeMiniIds.includes(ALL_NOTES_ID)}
                      onShowMini={() => showMini(ALL_NOTES_ID)}
                      onOpenFull={onOpenFullNote ? () => onOpenFullNote(ALL_NOTES_ID) : undefined}
                      onDelete={() => {}} />
                  </ul>
                ) : notes.length > 0 && (
                  <ul className={listClass(notes.length)}>
                    {notes.map((note, index) => (
                      <NoteRow key={note.id} note={note} index={index} ai={noteIsAi(note, footnote)}
                        readOnly={rowsAreReadOnly} canOpenMini={canOpenMini(note.id)} miniOpen={activeMiniIds.includes(note.id)}
                        onShowMini={() => showMini(note.id)}
                        onOpenFull={onOpenFullNote ? () => onOpenFullNote(note.id) : undefined}
                        onEdit={readOnly ? undefined : () => openTask({ kind: "note", id: note.id })}
                        onDelete={() => updateNotes(notes.filter((entry) => entry.id !== note.id))} />
                    ))}
                  </ul>
                )}
              </HubSection>
              )}
              {rowsAreReadOnly ? (
                whiteboards.length > 0 ? (
                  <HubSection title="Whiteboards">
                    <ul className={listClass(whiteboards.length)}>
                      {whiteboards.map((board) => (
                        <li key={board.id}>
                          <span className="lc-agent-scope-option">
                            <span className="lc-footnote-item-chip" data-type="whiteboard">{board.title || "Whiteboard"}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </HubSection>
                ) : null
              ) : (
              <HubSection title="Whiteboards" onAdd={onCreateWhiteboard}>
                {whiteboards.length > 0 && (
                  <ul className={listClass(whiteboards.length)}>
                    {whiteboards.map((board) => (
                      <li key={board.id}>
                        <HoldButton
                          label={board.title || "Whiteboard"}
                          className="lc-agent-scope-option lc-footnote-overview-entry-hold lc-hold-danger"
                          ariaLabel={`${board.title || "Whiteboard"} — tap to open, hold to delete`}
                          holdMs={HOLD_SENSITIVE_MS}
                          holdThrough
                          onTap={() => onOpenWhiteboard?.(board.id)}
                          onConfirm={() => removeWhiteboard(board.id)}
                        >
                          <span className="lc-footnote-item-chip" data-type="whiteboard">{board.title || "Whiteboard"}</span>
                        </HoldButton>
                      </li>
                    ))}
                  </ul>
                )}
              </HubSection>
              )}
              <HubSection title="Threads">
                {!readOnly && availableThreads.some(thread => !threads.some(link => link.rootId === thread.rootId)) &&
                  <ThreadLinkPicker
                    threads={availableThreads.filter(thread => !threads.some(link => link.rootId === thread.rootId))}
                    onPick={thread => onChange({...footnote,threads:[...threads,{...thread,createdAt:Date.now()}]})}
                  />}
                {threads.length > 0 && (
                  <ul className={listClass(threads.length)}>
                    {threads.map((thread) => (
                      <li key={thread.rootId}>
                        <HoldButton
                          label={thread.title}
                          ariaLabel={`${thread.title}. Tap to open, hold to unlink. Conversation stays saved`}
                          holdMs={HOLD_SENSITIVE_MS}
                          className="lc-agent-scope-option"
                          disabled={readOnly}
                          onConfirm={() => removeThread(thread.rootId)}
                          onTap={() => {
                            if (onOpenCoachThread) {
                              onOpenCoachThread(thread.rootId);
                              return;
                            }
                            openTask({ kind: "thread", rootId: thread.rootId });
                          }}
                        >
                          <span className="lc-footnote-item-chip" data-type="thread">{chipTitle(thread.title) || thread.title}</span>
                        </HoldButton>
                      </li>
                    ))}
                  </ul>
                )}
              </HubSection>
              {!rowsAreReadOnly && (
              <HubSection title="Attachments" onAdd={onManageArtifacts}>
                {onOpenArtifact && <ArtifactCards references={footnote.artifacts} onOpen={onOpenArtifact} />}
              </HubSection>
              )}
              <HubSection
                title="Links"
                onAdd={readOnly ? undefined : () => openTask({ kind: "link", index: null })}
              >
                {(searchLink || userLinks.length > 0) && (
                  <ul className={listClass(userLinks.length + (searchLink ? 1 : 0))}>
                    {searchLink && (
                      <li>
                        <button
                          type="button"
                          className="lc-agent-scope-option"
                          onClick={() => onOpenExternal(searchLink.url)}
                        >
                          <span className="lc-footnote-item-chip" data-type="url">{searchLink.title}</span>
                          <span className="lc-muted">{searchLink.url}</span>
                        </button>
                      </li>
                    )}
                    {userLinks.map((link, index) => (
                      <li key={`user-${index}-${link.url}`}>
                        <button
                          type="button"
                          className="lc-agent-scope-option"
                          onClick={() =>
                            readOnly
                              ? onOpenExternal(link.url)
                              : openTask({ kind: "link", index })
                          }
                        >
                          <span className="lc-footnote-item-chip" data-type="url">{link.title || link.url}</span>
                          {link.title ? <span className="lc-muted">{link.url}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </HubSection>
              {(onAddWorkspaceLink || (readOnly && workspaceLinks.length > 0)) && (
                <HubSection
                  title="Workspace links"
                  onAdd={readOnly ? undefined : onAddWorkspaceLink}
                >
                  {workspaceLinks.length > 0 && (
                    <ul className={listClass(workspaceLinks.length)}>
                      {workspaceLinks.map((link) => (
                        <li key={link.edgeId}>
                          <HoldButton
                            label={link.title}
                            className="lc-agent-scope-option lc-footnote-overview-entry-hold lc-hold-danger"
                            ariaLabel={`${link.title} — tap to open, hold to unlink`}
                            holdMs={HOLD_SENSITIVE_MS}
                            holdThrough
                            onTap={() => onOpenWorkspaceLink?.(link.edgeId)}
                            // Holding removes the *link*, never the thing it
                            // points at — the notebook on the other end is not
                            // this card's to delete.
                            onConfirm={() => history.removeLink(link.edgeId)}
                          >
                            <span className="lc-footnote-item-chip" data-type="file">{link.title}</span>
                            <span className="lc-muted">{link.kindLabel}</span>
                          </HoldButton>
                        </li>
                      ))}
                    </ul>
                  )}
                </HubSection>
              )}
              <ItemTypeKey types={[
                subMarks.length > 0 && "annotation",
                notes.some((note) => noteIsAi(note, footnote)) && "ai-note",
                notes.some((note) => !noteIsAi(note, footnote)) && "note",
                whiteboards.length > 0 && "whiteboard",
                threads.length > 0 && "thread",
                (footnote.artifacts?.length ?? 0) > 0 && "attachment",
                (userLinks.length > 0 || Boolean(searchLink)) && "url",
                workspaceLinks.length > 0 && "file",
              ]} />
            </motion.div>
          )}
        </AnimatePresence>
        <button
          type="button"
          className="lc-footnote-note-resize lc-footnote-panel-resize"
          aria-label="Resize footnote panel"
          title="Drag to resize"
          onPointerDown={event => beginPanelGesture(event, "resize")}
          onPointerMove={movePanelGesture}
          onPointerUp={endPanelGesture}
          onPointerCancel={endPanelGesture}
          onKeyDown={event => {
            const step = ({ ArrowRight: [16, 0], ArrowLeft: [-16, 0], ArrowDown: [0, 16], ArrowUp: [0, -16] } as Record<string, [number, number]>)[event.key];
            if (!step) return;
            event.preventDefault();
            nudgePanelSize(step[0], step[1]);
          }}
        ><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden><path d="M3 10 10 3M7 10l3-3" /></svg></button>
      </motion.div>
      {!onOpenMiniNote && <FootnoteMiniNotes entries={localMiniEntries} getBounds={localMiniBounds}
        onClose={ref => setLocalMiniNotes(current => current.filter(entry => entry.noteId !== ref.noteId))}
        onOpenExternal={onOpenExternal} />}
    </>,
    /*
     * Into the app root, not <body>. On Android the root is position: fixed,
     * which makes it its own stacking context, so a panel in <body> (z 231)
     * drew over every dialog inside the app, the offline gate (z 250)
     * included. Inside the root the z-indices compare as intended.
     */
    document.querySelector(".lc-app") ?? document.body,
  );
}
/**
 * "Link existing thread": a chip that opens the saved conversations as chips,
 * the same look as the agent panel's footnote picker.
 */
function ThreadLinkPicker({ threads, onPick }: {
  threads: readonly { rootId: string; title: string }[];
  onPick: (thread: { rootId: string; title: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !wrapRef.current?.contains(event.target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="lc-footnote-thread-picker" ref={wrapRef}>
      <button type="button" className={`lc-footnote-chip lc-footnote-thread-trigger${open ? " is-active" : ""}`}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <ThreadBubble />
        <span className="lc-footnote-chip-label">Link existing thread</span>
      </button>
      {open && (
        <div className="lc-footnote-thread-menu" role="menu" aria-label="Link an existing thread">
          {threads.map(thread => (
            <button key={thread.rootId} type="button" role="menuitem" className="lc-footnote-chip"
              onClick={() => { onPick(thread); setOpen(false); }}>
              <ThreadBubble />
              <span className="lc-footnote-chip-label">{thread.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadBubble() {
  return (
    <span className="lc-fn-badge lc-footnote-thread-badge" aria-hidden>
      <svg viewBox="0 0 16 16" focusable="false">
        <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v4A1.5 1.5 0 0 1 11.5 10H7l-3 2.5V10h0A1 1 0 0 1 3 9z"
          fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** Item kinds in the panel, each with its own chip color. */
export const ITEM_TYPES = [
  ["annotation", "Annotation"],
  ["ai-note", "AI note"],
  ["note", "Note"],
  ["whiteboard", "Whiteboard"],
  ["thread", "Thread"],
  ["attachment", "Attachment"],
  ["url", "URL"],
  ["file", "File"],
] as const;

/** A row of tiny chips naming the colors of the kinds this footnote holds. */
function ItemTypeKey({ types }: { types: ReadonlyArray<string | false> }) {
  const present = ITEM_TYPES.filter(([type]) => types.includes(type));
  if (present.length === 0) return null;
  return (
    <div className="lc-footnote-type-key" aria-label="Item colors">
      {present.map(([type, label]) => (
        <span key={type} className="lc-footnote-type-chip" data-type={type}>{label}</span>
      ))}
    </div>
  );
}

/** How long a tapped note keeps its buttons out with nothing touched. */
export const NOTE_ACTIONS_IDLE_MS = 4000;

/**
 * A note in the hub: a full-width row whose text is a short chip.
 *
 * Tapping it slides the row in from the right and shows the note's three
 * buttons (mini note, full note, edit) as small squares beside it; after a
 * few seconds untouched it slides back. Holding still deletes.
 */
function NoteRow({ note, index, ai, readOnly, canOpenMini, miniOpen, onShowMini, onOpenFull, onEdit, onDelete, chip: chipText, name }: {
  note: DocFootnoteNote;
  index: number;
  /** Chip words in place of the note's own, and the row's spoken name. */
  chip?: string;
  name?: string;
  ai: boolean;
  readOnly: boolean;
  canOpenMini: boolean;
  miniOpen: boolean;
  onShowMini: () => void;
  onOpenFull?: () => void;
  onEdit?: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const idle = useRef(0);
  const reduce = useReducedMotion();
  const keepOpen = useCallback(() => {
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setOpen(false), NOTE_ACTIONS_IDLE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(idle.current), []);
  const toggle = () => setOpen((value) => {
    if (value) window.clearTimeout(idle.current); else keepOpen();
    return !value;
  });
  const field = chipText ? null : fieldChip(note);
  const chip = <>
    {note.text ? <span className="lc-footnote-item-chip" data-type={ai ? "ai-note" : "note"}>
      {field ? <><span className="lc-footnote-field-tag">{field.tag}</span>{field.text}</> : chipText ?? (chipTitle(note.text) || plainPreview(note.text))}
    </span> : null}
    <NoteImages images={note.images} />
  </>;
  return (
    <li className={`lc-footnote-note-row${ai ? " is-ai" : ""}${open ? " is-open" : ""}`}
      onPointerDownCapture={open ? keepOpen : undefined} onFocusCapture={open ? keepOpen : undefined}>
      {ai ? (
        <span className="lc-footnote-note-ai" title="Written by ChatBot" aria-label="Written by ChatBot">
          <span aria-hidden>✦</span>
          <span aria-hidden>AI</span>
        </span>
      ) : null}
      {readOnly ? (
        <button type="button" className="lc-agent-scope-option lc-footnote-note-mini" aria-expanded={open}
          aria-label={`${name ?? `Note ${index + 1}`}: ${chipText ?? plainPreview(note.text)}. Tap for its buttons`} onClick={toggle}>{chip}</button>
      ) : (
        <HoldButton
          label={note.text || "Picture"}
          className="lc-agent-scope-option lc-footnote-overview-entry-hold lc-hold-danger"
          ariaLabel={`Note ${index + 1}: ${note.text ? plainPreview(note.text) : "picture"}. Tap for its buttons, hold to delete`}
          holdMs={HOLD_SENSITIVE_MS}
          holdThrough
          onTap={toggle}
          onConfirm={onDelete}
        >{chip}</HoldButton>
      )}
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div key="actions" className="lc-footnote-note-actions"
            initial={{ width: 0, opacity: 0 }} animate={{ width: "auto", opacity: 1 }} exit={{ width: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 40, mass: 0.7 }}>
            <button type="button" className="lc-footnote-mark-tool" aria-label={`Open mini note ${index + 1}`}
              disabled={!canOpenMini} aria-pressed={miniOpen}
              title={canOpenMini ? "Open mini note" : "Close a mini note to open another (3 maximum)"}
              onClick={onShowMini}><PictureInPictureIcon /></button>
            {onOpenFull ? <button type="button" className="lc-footnote-mark-tool" aria-label={`Open full note ${index + 1}`}
              title="Open note in tab" onClick={onOpenFull}><ExpandNoteIcon /></button> : null}
            {onEdit ? <button type="button" className="lc-footnote-mark-tool" aria-label={`Edit note ${index + 1}`}
              title="Edit note" onClick={onEdit}><PenToolIcon /></button> : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}

/** A note row shows plain words: markdown emphasis, code ticks and link syntax dropped. */
export function plainPreview(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|`)(?=\S)([^]*?\S)\1/g, "$2")
    .replace(/^#+\s+/gm, "");
}

/** Two stacked sheets becoming one: the notes shown as a single note. */
function CombineIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable="false">
      <rect x="2.5" y="2.5" width="8" height="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="5.5" y="7.5" width="8" height="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** A small curved arrow; Redo mirrors it. */
function HistoryArrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable="false">
      <path d="M5.5 4 2.5 7l3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 7h6.5a3.5 3.5 0 0 1 0 7H7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A hub list only becomes a scroller once it has more rows than `max-height`
 * always fits; shorter lists stay plain lists.
 */
const SCROLL_AT = 5;

function listClass(count: number): string {
  return count >= SCROLL_AT
    ? "lc-footnote-overview-link-list lc-footnote-overview-scroll-list is-scrolling lc-scroll-pane"
    : "lc-footnote-overview-link-list";
}

function HubSection({
  title,
  onAdd,
  extra,
  children,
}: {
  title: string;
  onAdd?: () => void;
  /** A small control beside the add button. */
  extra?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="lc-footnote-overview-section" aria-label={title}>
      <div className="lc-footnote-overview-section-head">
        <h3 className="lc-agent-turn-role">{title}</h3>
        {extra}
        {onAdd ? (
          <button
            type="button"
            className="lc-footnote-overview-add"
            aria-label={`Add ${title}`}
            onClick={onAdd}
          >
            +
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}
/** A note's pictures, small, under its words. */
function NoteImages({ images }: { images?: string[] }) {
  if (!images?.length) return null;
  return (
    <span className="lc-footnote-note-images">
      {images.map((image, i) => (
        <img key={i} src={`data:image/png;base64,${image}`} alt="" />
      ))}
    </span>
  );
}

function NoteTask({
  initial,
  initialImages,
  onSave,
  onBack,
}: {
  initial: string;
  initialImages: string[];
  onSave: (text: string, images: string[]) => void;
  onBack: () => void;
}) {
  const [text, setText] = useState(initial);
  const [images, setImages] = useState<string[]>(initialImages);
  const addImages = async () => {
    const room = NOTE_IMAGE_LIMIT - images.length;
    if (room <= 0) return;
    const picked = await pickPhotos(room).catch(() => []);
    if (picked.length > 0) setImages((now) => [...now, ...picked.map((photo) => photo.png)].slice(0, NOTE_IMAGE_LIMIT));
  };
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <>
      <textarea
        ref={ref}
        className="lc-footnote-bubble-note lc-footnote-overview-task-field"
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label="Note"
        placeholder="Write a note…"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onBack();
            return;
          }
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          onSave(text, images);
        }}
      />
      {images.length > 0 && (
        <div className="lc-footnote-note-images lc-footnote-note-images-edit">
          {images.map((image, i) => (
            <span key={i} className="lc-footnote-note-image">
              <img src={`data:image/png;base64,${image}`} alt={`Picture ${i + 1}`} />
              <button
                type="button"
                aria-label={`Remove picture ${i + 1}`}
                onClick={() => setImages((now) => now.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="lc-footnote-bubble-actions">
        <button type="button" className="lc-footnote-task-back" onClick={onBack}>
          Back
        </button>
        {images.length < NOTE_IMAGE_LIMIT && (
          <button type="button" onClick={() => void addImages()}>
            Add image
          </button>
        )}
        <button type="button" onClick={() => onSave(text, images)}>
          Save
        </button>
      </div>
    </>
  );
}
function LinkTask({
  initialUrl,
  initialTitle,
  onSave,
  onRemove,
  onBack,
}: {
  initialUrl: string;
  initialTitle: string;
  onSave: (url: string, title?: string) => void;
  onRemove?: () => void;
  onBack: () => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState(initialTitle);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const submit = () => onSave(url, title);
  return (
    <>
      <div className="lc-footnote-overview-add-link lc-footnote-overview-task-fields">
        <input
          ref={ref}
          type="url"
          placeholder="https://…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          aria-label="Link URL"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <input
          type="text"
          placeholder="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-label="Link title"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
      </div>
      <div className="lc-footnote-bubble-actions">
        <button type="button" className="lc-footnote-task-back" onClick={onBack}>
          Back
        </button>
        {onRemove && (
          <button
            type="button"
            className="lc-footnote-overview-add"
            aria-label="Remove link"
            onClick={onRemove}
          >
            ✕
          </button>
        )}
        <button type="button" onClick={submit} disabled={!url.trim()}>
          Save
        </button>
      </div>
    </>
  );
}
