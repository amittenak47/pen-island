import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import type { BoardHandle } from "../canvas/BoardHandle";
import { boardInkMix, padContentFingerprint } from "../canvas/snapshot";
import type { AgentChatMessage } from "../modes/AgentSidePanel";
import { persistableAgentMessages } from "../modes/agentTranscript";
import type { AnnotateMarkdownEditorHandle } from "../modes/AnnotateMarkdownEditor";
import type { ShellValue } from "../shellContext";
import { ANNOTATE_PAGE_W } from "../templates/annotate";
import {
  annotateDocLabel, AnnotateLibraryFullError, getAnnotateDoc, getAnnotateDocMeta,
  hashMarkdown, listAnnotateDocsByHash, saveAnnotateDoc, type AnnotateDoc, type DocType,
} from "../util/annotateStore";
import type { DocFootnote } from "../util/docFootnotes";
import { registerOpenAnnotateFootnotes } from "../util/footnoteRequests";
import { completeAnnotateSave, footnotesPendingSave, settleOpenFootnoteWrite, type HeldFootnoteAsk } from "../util/footnoteSaveBaseline";
import { FNWB_SAVED_EVENT } from "../util/footnoteWhiteboardStore";
import { annotateDocKey } from "../util/inkPageStore";
import { messageOf, traceOpen } from "../util/messageOf";
import { recordPadSnapshotsWithExtras } from "../util/padSnapshotExtras";
import type { TabRecord } from "../util/tabs";
import type { PdfFormValues } from "../modes/pdfForms";

type AnnotateSessionArgs = Pick<ShellValue, "patchTab" | "setError"> & {
  tab: Pick<TabRecord, "id" | "kind">;
  boardRef: RefObject<BoardHandle | null>;
};

type SaveContext = {
  agentMessages: AgentChatMessage[];
  agentMessagesRef: RefObject<AgentChatMessage[]>;
  saveEditBuffer: () => Promise<boolean>;
  closeFootnoteBoardSession: (reopenOverview?: boolean, strict?: boolean) => Promise<void>;
  footnoteBoardSessionRef: RefObject<object | null>;
  annotateFootnotesRef: RefObject<DocFootnote[]>;
  flushDirtyInk: (board: BoardHandle, docKey: string | null, attempt?: number, strict?: boolean) => Promise<void>;
};

/**
 * The open document's source, paper geometry and annotation save baseline.
 * Marks are shared with practice statements and are passed in by Workspace.
 *
 * Workspace binds the callbacks that also need its later shared state, and
 * registers the returned effect bodies at their original declaration sites.
 * This hook registers no effects: moving them here would precede PDF, storage,
 * coach and loading effects that used to run first.
 */
export function useAnnotateSession({ tab, boardRef, patchTab, setError }: AnnotateSessionArgs) {
  /** The document being annotated: its text, its name, and its content hash. */
  const [annotateSource, setAnnotateSource] = useState<{
    name: string;
    /** Markdown/code text, or captured HTML for web; empty for PDF and EPUB. */
    text: string;
    hash: string;
    docType: DocType;
    localFileHash?: string;
    /**
     * The file's bytes for PDF and EPUB, held for as long as the pad is open.
     *
     * A copy is in IndexedDB under {@link hash} for the next session; this one
     * is what the renderer parses now. Reading it back out of the store just to
     * hand it to a component in the same tick would be a round trip for
     * nothing.
     */
    bytes?: ArrayBuffer | null;
  } | null>(null);
  /** Library entry this session is writing to, once it has one. */
  const [annotateDocId, setAnnotateDocId] = useState<string | null>(null);
  /** This set is an owned note — its `source` is the document, not a copy. */
  const [annotateOwned, setAnnotateOwned] = useState(false);
  const annotateOwnedRef = useRef(false);
  annotateOwnedRef.current = annotateOwned;
  /**
   * Editing the note's markdown rather than drawing on it.
   *
   * Owned markdown only. Mutually exclusive with the pen: Monaco and the ink
   * layer both want the pointer, and a caret that sometimes draws is worse
   * than either mode on its own.
   */
  const [editMarkdown, setEditMarkdown] = useState(false);
  /** The live buffer while Edit is open — `content.source` until it is saved. */
  const [editBuffer, setEditBuffer] = useState("");
  const editBufferRef = useRef("");
  editBufferRef.current = editBuffer;
  const mdEditorRef = useRef<AnnotateMarkdownEditorHandle | null>(null);
  // Read from the autosave interval, which must not be torn down and rebuilt
  // every time one of these changes — a restarted timer is a skipped save.
  const annotateSourceRef = useRef<{
    name: string;
    text: string;
    hash: string;
    docType: DocType;
    localFileHash?: string;
  } | null>(null);
  const annotateDocIdRef = useRef<string | null>(null);
  /**
   * Measured document height, in scene units, driving the page frame.
   *
   * A page that ended before the text did would clip ink off the bottom of a
   * long document, so the frame is grown to the markdown rather than the other
   * way round.
   */
  const [annotateHeight, setAnnotateHeight] = useState<number | null>(null);
  /**
   * Open-gate copy of the measure. Must not be assigned from `annotateHeight`
   * each render — that stomps `onMdInkMeasure`'s same-tick write, so
   * `waitForAnnotateLaidOut` never sees three stable readings and text files
   * reveal at the 1100 floor with the pan clamp pinned.
   */
  const annotateHeightRef = useRef<number | null>(null);
  /** Scene width of the open markdown page — viewport-sized on fresh opens. */
  const [annotatePageWidth, setAnnotatePageWidth] = useState(ANNOTATE_PAGE_W);
  /** The width marks were placed at — recorded in an exported sidecar. */
  const annotatePageWidthRef = useRef(ANNOTATE_PAGE_W);
  annotatePageWidthRef.current = annotatePageWidth;
  const onMdInkMeasure = useCallback((height: number) => {
    // Only the suspicious reading is logged. A zero from a reader that has a
    // column is an empty note; a zero from one that has not laid out is how a
    // page gets stuck at `MD_INK_MIN_PAGE_H`, and the two are told apart in the
    // reader (see `MIN_MEASURABLE_WIDTH_PX`). If one still arrives here, it is
    // worth a line — it decides the height of the page and the ink clip on it.
    if (!(height > 0)) traceOpen("md-ink measured zero", { height });
    // Write the ref in this tick. The copy from React state only lands on the
    // next render, and `waitForAnnotateLaidOut` polls the ref — so a first
    // real height that sat only in state was invisible to the open gate.
    annotateHeightRef.current = height;
    setAnnotateHeight((prev) =>
      prev !== null && Math.abs(prev - height) < 1 ? prev : height,
    );
  }, []);
  /** Same discard contract as the scratchpad — see `whiteboardBaselineRef`. */
  const annotateBaselineRef = useRef<{ id: string | null; entry: AnnotateDoc | null }>({
    id: null,
    entry: null,
  });
  const annotatePristineHashRef = useRef<number | null>(null);
  /** Footnote revision at open / last explicit save — not merely "any footnotes". */
  const annotatePristineMarksRef = useRef("");
  /**
   * A fillable PDF's values, and what they were at open / last explicit save.
   * Filling a form without inking is still work, so leaving offers to keep it.
   */
  const annotateFormFieldsRef = useRef<PdfFormValues>({});
  const annotatePristineFormRef = useRef("{}");
  /** Asks whose pending mark has not yet been stored, so they must not be posted. */
  const heldFootnoteAsksRef = useRef<HeldFootnoteAsk[]>([]);
  const deliverHeldFootnoteAsksRef = useRef<
    (
      saved: { id: string; footnotes?: readonly DocFootnote[] | null },
      asks: readonly HeldFootnoteAsk[],
    ) => Promise<void>
  >(async () => {});
  /** Persistable coach thread at open / last explicit save. */
  const annotatePristineAgentRef = useRef("");
  annotateSourceRef.current = annotateSource;
  annotateDocIdRef.current = annotateDocId;

  const trackFootnoteBoardSaves = (setAnnotateFootnotes: Dispatch<SetStateAction<DocFootnote[]>>) => {
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ docId: string; wbId: string }>).detail;
      if (!detail || detail.docId !== annotateDocIdRef.current) return;
      setAnnotateFootnotes((current) =>
        current.map((entry) => ({
          ...entry,
          whiteboards: (entry.whiteboards ?? []).map((row) =>
            row.id === detail.wbId ? { ...row, updatedAt: Date.now() } : row,
          ),
        })),
      );
    };
    window.addEventListener(FNWB_SAVED_EVENT, onSaved);
    return () => window.removeEventListener(FNWB_SAVED_EVENT, onSaved);
  };
  /** Nothing drawn on this document since it opened. */
  /**
   * Nothing about this session is worth keeping.
   *
   * An untouched *board* is not an untouched *document*: a reading session can
   * quote a passage to the coach or drop a search footnote without ever putting
   * the pen down, and those are exactly as worth keeping as ink. Counting only
   * the board here is what made leaving throw a footnote-only session away
   * without so much as offering to save it — the leave dialog never appeared,
   * because from the board's point of view nothing had happened.
   */
  const createAnnotateUntouched = ({ agentMessagesRef, annotateFootnotesRef }:
    Pick<SaveContext, "agentMessagesRef" | "annotateFootnotesRef">) => () => {
    const board = boardRef.current;
    const pristine = annotatePristineHashRef.current;
    if (!board || pristine === null) return false;
    /*
     * An edited buffer is a change even when nothing was drawn.
     *
     * The board fingerprint cannot see Monaco, so a note whose text was
     * rewritten but never inked would read as "only read" and be discarded on
     * the way out without so much as a prompt.
     */
    if (annotateOwnedRef.current && editBufferRef.current !== (annotateSourceRef.current?.text ?? "")) {
      return false;
    }
    if (footnotesPendingSave(annotateFootnotesRef.current, annotatePristineMarksRef.current)) {
      return false;
    }
    if (JSON.stringify(annotateFormFieldsRef.current) !== annotatePristineFormRef.current) return false;
    if (
      JSON.stringify(persistableAgentMessages(agentMessagesRef.current)) !==
      annotatePristineAgentRef.current
    ) {
      return false;
    }
    return padContentFingerprint(board.getElements(), boardInkMix(board)) === pristine;
  };

  /** Commit the annotations to the library. Returns the entry, or null on failure. */
  const createSaveAnnotateSession = ({
    agentMessages, agentMessagesRef, saveEditBuffer, closeFootnoteBoardSession,
    footnoteBoardSessionRef, annotateFootnotesRef, flushDirtyInk,
  }: SaveContext) => async (opts?: { label?: string; throwOnError?: boolean }): Promise<AnnotateDoc | null> => {
    const board = boardRef.current;
    let source = annotateSource;
    if (!board || !source) return null;
    if (footnoteBoardSessionRef.current) {
      await closeFootnoteBoardSession(false, opts?.throwOnError);
    }
    // Commit the buffer first: the write below sends `source.text`, which is
    // still the pre-edit copy until `saveEditBuffer` has moved it.
    if (annotateOwnedRef.current && editBufferRef.current !== source.text) {
      const editedText = editBufferRef.current;
      if (await saveEditBuffer()) {
        // React state updates do not replace this callback's captured source.
        source = { ...source, text: editedText, hash: hashMarkdown(editedText) };
      } else if (opts?.throwOnError) {
        throw new Error("Could not save the edited document. Your changes are still open.");
      }
    }
    await flushDirtyInk(board, annotateDocId ? annotateDocKey(annotateDocId) : null, 0, opts?.throwOnError);
    const blob = board.saveBoard({ assembleInk: false });
    if (!blob) return null;
    try {
      const namedLabel = opts?.label?.trim();
      const saved = await saveAnnotateDoc({
        id: annotateDocId ?? undefined,
        name: source.name,
        hash: source.hash,
        source: source.text,
        docType: source.docType,
        ...(namedLabel ? { label: namedLabel, metadataIntent: "rename" as const } : {}),
        board: blob,
        footnotes: annotateFootnotesRef.current,
        agent: persistableAgentMessages(agentMessagesRef.current),
      });
      annotateDocIdRef.current = saved.id;
      setAnnotateDocId(saved.id);
      const tabTitle = saved.label?.trim()
        ? saved.label.trim()
        : tab.kind === "web"
          ? undefined
          : (() => {
              const siblings = listAnnotateDocsByHash(saved.hash);
              return siblings.length > 1 ? annotateDocLabel(saved) : saved.name;
            })();
      patchTab(tab.id, {
        docId: saved.id,
        ...(tabTitle ? { title: tabTitle } : {}),
      });
      annotateBaselineRef.current = { id: saved.id, entry: saved };
      annotatePristineHashRef.current = padContentFingerprint(
        board.getElements(),
        boardInkMix(board),
      );
      const delivered = completeAnnotateSave({
        saved,
        live: annotateFootnotesRef.current,
        pristine: annotatePristineMarksRef,
        held: heldFootnoteAsksRef.current,
      });
      heldFootnoteAsksRef.current = delivered.keep;
      await deliverHeldFootnoteAsksRef.current(saved, delivered.send);
      annotatePristineAgentRef.current = JSON.stringify(persistableAgentMessages(agentMessages));
      annotatePristineFormRef.current = JSON.stringify(annotateFormFieldsRef.current);
      await recordPadSnapshotsWithExtras({
            kind: "annotate",
            key: saved.id,
            name: saved.name,
            board: blob,
            footnotes: saved.footnotes,
            agent: saved.agent,
      });
      return saved;
    } catch (cause) {
      if (opts?.throwOnError) throw cause;
      if (cause instanceof AnnotateLibraryFullError) {
        setError(cause.message);
        return null;
      }
      setError(messageOf(cause));
      return null;
    }
  };
  const registerAnnotateFootnotes = (
    saveAnnotateSession: () => Promise<AnnotateDoc | null>,
    annotateFootnotesRef: RefObject<DocFootnote[]>,
    setAnnotateFootnotes: Dispatch<SetStateAction<DocFootnote[]>>,
  ) => {
    return registerOpenAnnotateFootnotes({
      docId: () => annotateDocIdRef.current,
      write: (docId, mutate) => settleOpenFootnoteWrite({
        docId,
        openDocId: annotateDocIdRef.current,
        live: annotateFootnotesRef,
        pristine: annotatePristineMarksRef,
        mutate,
        publish: (next) => {
          flushSync(() => setAnnotateFootnotes(next));
        },
        save: () => saveAnnotateSession(),
      }),
    });
  };

  const mirrorAnnotateDocId = () => {
    const docId = annotateDocId;
    if (!docId) {
      patchTab(tab.id, { docId });
      return;
    }
    let cancelled = false;
    void getAnnotateDoc(docId).then((doc) => {
      if (cancelled) return;
      patchTab(tab.id, {
        docId,
        ...(doc?.source ? { source: null } : {}),
      });
    });
    return () => {
      cancelled = true;
    };
  };
  const mirrorAnnotateTitle = () => {
    if (!annotateDocId) return;
    const meta = getAnnotateDocMeta(annotateDocId);
    if (!meta) return;
    if (meta.label?.trim()) {
      patchTab(tab.id, { title: meta.label.trim() });
      return;
    }
    if (tab.kind === "web") return;
    const siblings = listAnnotateDocsByHash(meta.hash);
    patchTab(tab.id, { title: siblings.length > 1 ? annotateDocLabel(meta) : meta.name });
  };

  return {
    annotateSource, setAnnotateSource, annotateSourceRef,
    annotateDocId, setAnnotateDocId, annotateDocIdRef,
    annotateOwned, setAnnotateOwned, annotateOwnedRef,
    editMarkdown, setEditMarkdown, editBuffer, setEditBuffer, editBufferRef, mdEditorRef,
    annotateHeight, setAnnotateHeight, annotateHeightRef, onMdInkMeasure,
    annotatePageWidth, setAnnotatePageWidth, annotatePageWidthRef,
    annotateBaselineRef, annotatePristineHashRef, annotatePristineMarksRef, annotatePristineAgentRef,
    annotateFormFieldsRef, annotatePristineFormRef,
    heldFootnoteAsksRef, deliverHeldFootnoteAsksRef,
    createAnnotateUntouched, createSaveAnnotateSession,
    trackFootnoteBoardSaves, registerAnnotateFootnotes, mirrorAnnotateDocId, mirrorAnnotateTitle,
  };
}
