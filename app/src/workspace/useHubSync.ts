import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { DocIndexStatus, SearchOptions } from "../api/client";
import type { ProblemDetail } from "../api/types";
import type { BoardHandle } from "../canvas/BoardHandle";
import { boardInkMix, padContentFingerprint, sceneFingerprint } from "../canvas/snapshot";
import type { DocIndexNote, DocWorkProgress } from "../components/DocIndexChip";
import type { HubSyncWalkHost, HubWalkReport } from "../components/HubSyncControl";
import type { AgentChatMessage } from "../modes/AgentSidePanel";
import { persistableAgentMessages, restoreAgentMessages } from "../modes/agentTranscript";
import type { ShellValue } from "../shellContext";
import { annotateFrameWidthFromElements } from "../templates/annotate";
import { buildWhiteboardTemplate, countWhiteboardPages } from "../templates/whiteboard";
import { isDarkTheme } from "../theme/appThemes";
import { getAnnotateDoc, isBinaryDocType, markAnnotateHubAck, saveAnnotateDoc, type DocType } from "../util/annotateStore";
import { hubReloadAppState, hubReloadDocumentElements } from "../util/boardHubReload";
import { askBookConflict } from "../util/bookConflictUi";
import type { BookSyncOptions } from "../util/bookSync";
import { bookNoticeMessage } from "../util/bookSyncMessages";
import { BOOK_PASS_STATUS_EVENT, type BookPassResult } from "../util/bookSyncPass";
import { conflictUiSession } from "../util/conflictUiSession";
import { footnoteRevision, type DocFootnote } from "../util/docFootnotes";
import { HubSyncCancelled, type HubConflictResolution, type HubPadConflict } from "../util/hubConflictStash";
import { HUB_SYNC_WINDOW_PILL_EVENT, loadHubSyncWindowPill } from "../util/hubSyncWindowPillPref";
import { annotateDocKey, whiteboardDocKey } from "../util/inkPageStore";
import { loadPadSyncSince } from "../util/padHub";
import { isPadHubOffline } from "../util/padHubStatus";
import { annotatePadBody, whiteboardPadBody, waitForPadPushes, PAD_HUB_WINDOW_EVENT, type PadHubWindowDetail } from "../util/padSync";
import type { ProblemArtifactConflict } from "../util/problemArtifactConflict";
import { getProblemBoard, problemPadId, putProblemBoard } from "../util/problemBoardStore";
import type { TabRecord } from "../util/tabs";
import { getWhiteboardNotebook, markWhiteboardHubAck, saveWhiteboardNotebook, WHITEBOARD_PAGE_LIMIT } from "../util/whiteboardStore";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Source = { name: string; hash: string; text: string; docType: DocType; localFileHash?: string };
type HubConflictAsk = {
  conflict: HubPadConflict;
  problemConflict?: ProblemArtifactConflict;
  resolve(resolution: HubConflictResolution): void;
  cancel?(): void;
  onMounted?(): void;
  onUnavailable?(): void;
} | null;
type LoadProblem = (taskId: string, bank: SearchOptions | undefined,
  opts: { keepSessionNav?: boolean; tabId: string; userLoad?: boolean }) => Promise<boolean>;
type HubSyncArgs = Pick<ShellValue, "client"> & {
  tab: Pick<TabRecord, "id">;
  boardRef: RefObject<BoardHandle | null>;
  whiteboardNotebookIdRef: RefObject<string | null>;
  annotateDocIdRef: RefObject<string | null>;
  annotateSourceRef: RefObject<Source | null>;
  annotateFootnotesRef: RefObject<DocFootnote[]>;
  footnoteBoardRef: RefObject<object | undefined>;
  footnoteBoardSessionRef: RefObject<object | null>;
  hubConflictAskRef: RefObject<HubConflictAsk>;
  setHubConflictAsk: Setter<HubConflictAsk>;
  setHubConflictError: Setter<string | null>;
  setDocIndexStatus: Setter<"idle" | "indexing" | "indexed" | "error">;
  setDocIndexError: Setter<string | null>;
  setDocIndexMeta: Setter<DocIndexStatus | null>;
  setDocIndexNote: Setter<DocIndexNote | null>;
  isLocalPad: (problem: ProblemDetail | null | undefined) => boolean;
  flushDirtyInk: (board: BoardHandle, docKey: string | null, attempt?: number, strict?: boolean) => Promise<void>;
};
type HostContext = {
  problemRef: RefObject<ProblemDetail | null>;
  agentMessagesRef: RefObject<AgentChatMessage[]>;
  indexInputsRef: RefObject<{
    hash: string; name: string; docType: DocType; text: string; bytes: ArrayBuffer | null; delayMs: number;
  } | null>;
  loadProblem: LoadProblem;
  setDocIndexProgress: Setter<DocWorkProgress | null>;
};
type ReloadContext = Pick<ShellValue, "themeId"> & {
  padHubApplyRef: RefObject<boolean>;
  boardSaveSuspendedRef: RefObject<boolean>;
  setWhiteboardPageCount: Setter<number>;
  agentMessagesRef: RefObject<AgentChatMessage[]>;
  setAgentMessages: Setter<AgentChatMessage[]>;
  lastEditSeqHashRef: RefObject<number | null>;
  lastEditSeqMarksRef: RefObject<string>;
  annotatePageWidthRef: RefObject<number>;
  setAnnotatePageWidth: Setter<number>;
  annotateHeightRef: RefObject<number | null>;
  setAnnotateHeight: Setter<number | null>;
  setAnnotateFootnotesRaw: Setter<DocFootnote[]>;
  setAnnotateSource: Setter<(Source & { bytes?: ArrayBuffer | null }) | null>;
  restoreInk: (board: BoardHandle, docKey: string | null, blob: { ink?: unknown; inkC?: unknown }) => Promise<void>;
};
type WindowContext = Pick<ShellValue, "closeTab" | "setNotice"> & {
  problemRef: RefObject<ProblemDetail | null>;
  dirtyRef: RefObject<boolean>;
  lastEditSeqHashRef: RefObject<number | null>;
  padHubApplyRef: RefObject<boolean>;
  loadProblem: LoadProblem;
};

/** Names for the parts of `syncWorkingRevisionRef`, in the order it lists them. */
const SYNC_REVISION_PARTS = ["notebook", "document", "ink", "footnotes", "chat", "text", "paper"];

/** Which parts of the page differ between two sync revisions, for the error a reader sees. */
function changedRevisionParts(before: string | null, after: string): string {
  try {
    const a = JSON.parse(before ?? "[]") as unknown[];
    const b = JSON.parse(after || "[]") as unknown[];
    const changed = SYNC_REVISION_PARTS.filter((_, i) => JSON.stringify(a[i]) !== JSON.stringify(b[i]));
    return changed.length > 0 ? changed.join(", ") : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The open pad's Sync walk host, progress, tap and live hub delivery.
 * Shared board/loading state and the problem-artifact merge split stay in
 * Workspace. As in useAnnotateSession, effect bodies are registered there at
 * their original sites so their order relative to other modes is unchanged.
 */
export function useHubSync({
  client, tab, boardRef, whiteboardNotebookIdRef, annotateDocIdRef,
  annotateSourceRef, annotateFootnotesRef, footnoteBoardRef, footnoteBoardSessionRef,
  hubConflictAskRef, setHubConflictAsk, setHubConflictError,
  setDocIndexStatus, setDocIndexError, setDocIndexMeta, setDocIndexNote, isLocalPad, flushDirtyInk,
}: HubSyncArgs) {
  /** How far the Sync walk has got, for the chip beside the document name. */
  const [walkReport, setWalkReport] = useState<HubWalkReport | null>(null);
  const sharedWalkRef = useRef(walkReport);
  sharedWalkRef.current = walkReport;
  const [padEditSeq, setPadEditSeq] = useState(0);
  const bumpPadEdit = useCallback(() => setPadEditSeq((n) => n + 1), []);
  const hubSyncTapRef = useRef<(() => void) | null>(null);
  const onHubSync = useCallback(() => {
    hubSyncTapRef.current?.();
  }, []);
  const [hubSyncWindowPill, setHubSyncWindowPill] = useState(loadHubSyncWindowPill);

  const hubSyncHostRef = useRef<HubSyncWalkHost | null>(null);
  const lifecycleSyncOptions: BookSyncOptions = {
    manual: true, requestChoice: (conflict, lifecycle) => askBookConflict(conflict, lifecycle,
      (shown, mounted) => hubSyncHostRef.current!.onConflict(shown, mounted)),
  };
  const syncWorkingRevisionRef = useRef<(() => string)>(() => "");
  /** A Sync tap is running: it reloads the open pad itself, at its end. */
  const syncWalkActiveRef = useRef(false);
  const syncPreparedRevisionRef = useRef<string | null>(null);
  /**
   * Live rehydrate after a walk (and after auto-sync apply).
   *
   * Held in a ref because the host object is created once, on first render,
   * and must call whatever this is *now* — not the empty stub from mount.
   */
  const applyHubReloadRef = useRef<(detail: PadHubWindowDetail) => Promise<void>>(
    async () => {},
  );

  const bindSyncWorkingRevision = (agentMessagesRef: RefObject<AgentChatMessage[]>) => {
    syncWorkingRevisionRef.current = () => {
      const board = boardRef.current;
      if (!board) return "";
      return JSON.stringify([
        whiteboardNotebookIdRef.current, annotateDocIdRef.current,
        padContentFingerprint(board.getElements(), boardInkMix(board)),
        footnoteRevision(annotateFootnotesRef.current),
        persistableAgentMessages(agentMessagesRef.current),
        annotateSourceRef.current?.text,
        board.saveBoard({ assembleInk: false }).appState.linedPaperMode,
      ]);
    };
  };

  const trackBookPass = (active: boolean) => {
    if (!active) return;
    let disposed=false;
    const onPass = async (event: Event) => {
      const detail = (event as CustomEvent<{ passive: boolean; result: BookPassResult; summary: string | null }>).detail;
      if (!detail?.passive || detail.result.cancelled || !detail.result.books.length && !detail.result.notices.length) return;
      const current = sharedWalkRef.current;
      if (current && !current.error && current.stage !== "idle" && current.stage !== "synced") return;
      const message=detail.result.notices.map(bookNoticeMessage).join(" ")||null;
      let owner:{kind:string;id:string}|null=null;
      try{owner=await hubSyncHostRef.current?.book?.()??null;}catch{/* Displaying a notice must not hide a storage failure. */}
      if(disposed)return;
      const latest=sharedWalkRef.current;
      if(latest&&!latest.error&&latest.stage!=="idle"&&latest.stage!=="synced")return;
      if(detail.summary)setWalkReport({stage:"pad",progress:null,error:detail.summary});
      else if(owner&&detail.result.books.some(book=>book.kind===owner.kind&&book.id===owner.id&&["synced","unchanged"].includes(book.status)))setWalkReport({stage:"synced",progress:null,message});
      else if(message)setWalkReport(previous=>({...previous,stage:previous?.stage??"idle",progress:null,message}));
    };
    window.addEventListener(BOOK_PASS_STATUS_EVENT, onPass);
    return () => {disposed=true;window.removeEventListener(BOOK_PASS_STATUS_EVENT, onPass);};
  };
  const trackHubSyncWindowPill = () => {
    const onPref = () => setHubSyncWindowPill(loadHubSyncWindowPill());
    window.addEventListener(HUB_SYNC_WINDOW_PILL_EVENT, onPref);
    return () => window.removeEventListener(HUB_SYNC_WINDOW_PILL_EVENT, onPref);
  };

  // Preserve the once-created host's first-render closure. These shared
  // declarations occur later in Workspace, so read them only when called.
  const createHubSyncHost = (getContext: () => HostContext) => {
    if (!hubSyncHostRef.current) {
      hubSyncHostRef.current = {
        book: async () => {
          const { problemRef } = getContext();
          if (footnoteBoardRef.current) return null;
          if (whiteboardNotebookIdRef.current && await getWhiteboardNotebook(whiteboardNotebookIdRef.current)) return { kind: "whiteboard", id: whiteboardNotebookIdRef.current };
          if (annotateDocIdRef.current && await getAnnotateDoc(annotateDocIdRef.current)) return { kind: "annotate", id: annotateDocIdRef.current };
          const current = problemRef.current;
          return current && !isLocalPad(current) ? { kind: "problem", id: problemPadId(current.dataset, current.task_id) } : null;
        },
        prepare: async () => {
          const { problemRef, agentMessagesRef } = getContext();
          const board = boardRef.current;
          const notebookId = whiteboardNotebookIdRef.current;
          const docId = annotateDocIdRef.current;
          if (!board || footnoteBoardRef.current) return;
          if (footnoteBoardSessionRef.current) throw new Error("Close the scratch board before syncing the document.");
          if (!notebookId && !docId) {
            const current = problemRef.current;
            if (!current || isLocalPad(current)) return;
            const id = problemPadId(current.dataset, current.task_id), previous = await getProblemBoard(id);
            if (!previous) return;
            const revision = syncWorkingRevisionRef.current();
            await putProblemBoard({ ...previous, board: board.saveBoard(), agent: persistableAgentMessages(agentMessagesRef.current), updatedAt: Date.now() });
            if (revision !== syncWorkingRevisionRef.current()) throw new Error("The page changed while preparing sync. Your edits are kept; sync again.");
            syncPreparedRevisionRef.current = revision; return;
          }
          const id = notebookId ?? docId;
          if (!id) return;
          const kind = notebookId ? "whiteboard" : "annotate";
          if (!isPadHubOffline()) await waitForPadPushes(kind, id);
          // A rerender refreshes the handle without replacing the mounted board.
          if (boardRef.current?.instanceId !== board.instanceId || (notebookId ? whiteboardNotebookIdRef.current : annotateDocIdRef.current) !== id) {
            throw new Error("The open pad changed. Sync the current pad again.");
          }
          await flushDirtyInk(board, notebookId ? whiteboardDocKey(id) : annotateDocKey(id), 0, true);
          const revision = syncWorkingRevisionRef.current();
          const live = board.saveBoard({ assembleInk: false });
          const agent = persistableAgentMessages(agentMessagesRef.current);
          if (notebookId) {
            const previous = await getWhiteboardNotebook(id);
            if (!previous) return;
            await saveWhiteboardNotebook({
              id, board: live, agent,
              pageCount: Math.max(previous.pageCount, countWhiteboardPages(live.elements)),
            });
          } else {
            const source = annotateSourceRef.current;
            if (!source) return;
            await saveAnnotateDoc({
              id, name: source.name, hash: source.hash, source: source.text,
              docType: source.docType, board: live, agent,
              footnotes: annotateFootnotesRef.current,
            });
          }
          // This is the working copy. Explicit Save alone owns the baseline.
          if (revision !== syncWorkingRevisionRef.current()) {
            throw new Error(`The page changed while preparing sync (${changedRevisionParts(revision, syncWorkingRevisionRef.current())}). Your edits are kept; sync again.`);
          }
          syncPreparedRevisionRef.current = revision;
        },
        doc: () => {
          const { indexInputsRef } = getContext();
          const job = indexInputsRef.current;
          if (!job) return null;
          return {
            hash: job.hash,
            name: job.name,
            docType: job.docType,
            text: job.text,
            bytes: job.bytes,
          };
        },
        /*
         * The open pad, read live from IDB so the walk pushes what is on the
         * device right now — not what was there when the pill mounted. Null on
         * boards that are not a hub pad (home, problem sets for now).
         */
        pad: async () => {
          if (footnoteBoardRef.current) return null;
          // Refs, not the first-render `problem`: this host object is created
          // once, and a whiteboard opened later would otherwise look like
          // "no pad" for the rest of the tab's life.
          const notebookId = whiteboardNotebookIdRef.current;
          if (notebookId) {
            const notebook = await getWhiteboardNotebook(notebookId);
            if (!notebook) return null;
            return {
              kind: "whiteboard" as const,
              id: notebook.id,
              hubAckUpdatedAt: () => notebook.hubAckUpdatedAt ?? 0,
              buildBody: () => whiteboardPadBody(notebook),
              markHubAck: (updatedAt: number) =>
                markWhiteboardHubAck(notebook.id, updatedAt),
            };
          }
          const docId = annotateDocIdRef.current;
          if (!docId) return null;
          const doc = await getAnnotateDoc(docId);
          if (!doc) return null;
          return {
            kind: "annotate" as const,
            id: doc.id,
            hubAckUpdatedAt: () => doc.hubAckUpdatedAt ?? 0,
            buildBody: () => annotatePadBody(doc),
            markHubAck: (updatedAt: number) => markAnnotateHubAck(doc.id, updatedAt),
          };
        },
        emitReload: () => {
          const { problemRef, loadProblem } = getContext();
          if (syncPreparedRevisionRef.current !== null &&
              syncPreparedRevisionRef.current !== syncWorkingRevisionRef.current()) {
            const parts = changedRevisionParts(syncPreparedRevisionRef.current, syncWorkingRevisionRef.current());
            console.warn("[lc-sync] page changed during sync:", parts);
            throw new Error(`The page changed during sync (${parts}). Your edits are kept; sync again to send them.`);
          }
          const notebookId = whiteboardNotebookIdRef.current;
          if (notebookId) {
            return applyHubReloadRef.current({
              kind: "whiteboard",
              id: notebookId,
              op: "reload",
            });
          }
          const docId = annotateDocIdRef.current;
          if (!docId) {
            const current = problemRef.current;
            if (current && !isLocalPad(current)) return loadProblem(current.task_id, { dataset: current.dataset }, { tabId: tab.id, userLoad: false }).then(() => {});
            return;
          }
          return applyHubReloadRef.current({
            kind: "annotate",
            id: docId,
            op: "reload",
          });
        },
        inkSince: () => loadPadSyncSince(),
        /*
         * A conflict stopped the walk. Park the split over this workspace and
         * hold the walk until the reader has chosen and the choice is written
         * into IDB — the pill resumes from there and owns any hub traffic.
         */
        onConflict: (conflict, lifecycle) =>
          new Promise<HubConflictResolution>((resolve, reject) => {
            if (lifecycle?.signal.aborted) { reject(new Error("Sync stopped.")); return; }
            const ui = conflictUiSession(lifecycle);
            setHubConflictError(null);
            const clear = () => {
              if (hubConflictAskRef.current !== ask) return;
              hubConflictAskRef.current = null;
              setHubConflictAsk(null);
              setHubConflictError(null);
            };
            const finish = (resolution?: HubConflictResolution) => {
              ui.complete();
              lifecycle?.signal.removeEventListener("abort", onAbort);
              clear();
              if (resolution) resolve(resolution);
              else reject(new HubSyncCancelled());
            };
            const onAbort = () => { ui.complete(); clear(); reject(new Error("Sync stopped. Tap Sync to retry.")); };
            const ask = { conflict, resolve: (value: HubConflictResolution) => finish(value), cancel: () => finish(),
              onMounted: ui.onMounted, onUnavailable: ui.onUnavailable };
            lifecycle?.signal.addEventListener("abort", onAbort, { once: true });
            hubConflictAskRef.current = ask;
            setHubConflictAsk(ask);
          }),
        onIndexProgress: (progress) => getContext().setDocIndexProgress(progress),
        onWalkProgress: (report) => {
          syncWalkActiveRef.current = report != null && report.stage !== "synced" && report.stage !== "idle" && !report.error;
          setWalkReport(report);
        },
        // The hub has an index for this document now, whether the walk built it
        // or found it already there. Nothing used to say so, so the chip kept
        // reading "not indexed" about a document that was.
        onIndexDone: (embedOffline) => {
          const { indexInputsRef } = getContext();
          setDocIndexStatus("indexed");
          setDocIndexError(null);
          setDocIndexNote(embedOffline ? { kind: "embed-offline", detail: embedOffline } : null);
          /*
           * And the numbers, not only the word.
           *
           * The chip's popover reads pages, chunks and embed state off `meta`.
           * Saying "indexed" without refreshing it left the card describing
           * whatever was there before the walk — usually nothing at all, for a
           * document the walk had just indexed.
           */
          const hash = indexInputsRef.current?.hash;
          if (!hash) return;
          void client
            .getDocIndex(hash)
            .then((meta) => setDocIndexMeta(meta))
            .catch(() => {});
        },
        // Said once, not retried: the reader taps Sync again when the
        // desktop app is back. The index status is left as it was known.
        onIndexOffline: () => setDocIndexNote({ kind: "hub-offline", detail: null }),
        onIndexError: (message) => {
          setDocIndexNote(null);
          if (message) {
            setDocIndexStatus("error");
            setDocIndexError(message);
          } else {
            setDocIndexStatus("idle");
            setDocIndexError(null);
          }
        },
      };
    }
  };

  /*
   * Put the walk's result on the board that is already open.
   *
   * A full loadAnnotate remounts the PDF (and used to do it without the bytes,
   * so the paper went blank). This keeps the document, the camera, and the
   * search-index chip, and only replaces ink, marks, and board elements from
   * the row the walk just wrote. Auto-sync still fires the window event;
   * the pill calls this directly so Pull can await it.
   */
  const bindHubReload = ({
    themeId, padHubApplyRef, boardSaveSuspendedRef, setWhiteboardPageCount,
    agentMessagesRef, setAgentMessages, lastEditSeqHashRef, lastEditSeqMarksRef,
    annotatePageWidthRef, setAnnotatePageWidth, annotateHeightRef, setAnnotateHeight,
    setAnnotateFootnotesRaw, setAnnotateSource, restoreInk,
  }: ReloadContext) => {
    applyHubReloadRef.current = async (detail) => {
      if (detail.op !== "reload") return;
      const board = boardRef.current;
      if (!board) return;
      const beforeReload = syncWorkingRevisionRef.current();
      if (detail.kind === "whiteboard") {
        if (whiteboardNotebookIdRef.current !== detail.id) return;
        const notebook = await getWhiteboardNotebook(detail.id);
        if (!notebook) return;
        if (boardRef.current?.instanceId !== board.instanceId || whiteboardNotebookIdRef.current !== detail.id) return;
        if (beforeReload !== syncWorkingRevisionRef.current()) throw new Error("The page changed during reload. Sync again.");
        padHubApplyRef.current = true;
        boardSaveSuspendedRef.current = true;
        try {
          const live = board.saveBoard({ assembleInk: false });
          const pages = Math.min(
            WHITEBOARD_PAGE_LIMIT,
            Math.max(1, notebook.pageCount, countWhiteboardPages(notebook.board.elements)),
          );
          board.restoreBoard(notebook.board.elements, hubReloadAppState(live.appState, notebook.board.appState), {
            skeletons: buildWhiteboardTemplate(pages, isDarkTheme(themeId)),
            files: notebook.board.files,
            inkPalettes: notebook.board.inkPalettes,
            skipFit: true,
          });
          setWhiteboardPageCount(pages);
          await restoreInk(board, whiteboardDocKey(notebook.id), notebook.board);
          /*
           * Open width-fits after ink so the lined page is the ink's screen box.
           * Reload used to keep the camera from under the conflict overlay, which
           * cropped the title off the left and locked X, so a flick could not
           * reach it. Leave annotate: Ink Lab on the pad ate the scroll gesture.
           */
          await board.settleFitView();
          board.armReadingScroll();
          agentMessagesRef.current = restoreAgentMessages(notebook.agent);
          setAgentMessages(agentMessagesRef.current);
          const inkMix = boardInkMix(board);
          lastEditSeqHashRef.current = sceneFingerprint(board.getElements(), inkMix);
          lastEditSeqMarksRef.current = "";
        } finally {
          padHubApplyRef.current = false;
          boardSaveSuspendedRef.current = false;
        }
        requestAnimationFrame(() => {
          const live = boardRef.current;
          if (!live) return;
          live.nudgeViewportFit();
          lastEditSeqHashRef.current = sceneFingerprint(
            live.getElements(),
            boardInkMix(live),
          );
        });
        return;
      }
      if (detail.kind !== "annotate") return;
      if (annotateDocIdRef.current !== detail.id) return;
      const doc = await getAnnotateDoc(detail.id);
      if (!doc) return;
      if (boardRef.current?.instanceId !== board.instanceId || annotateDocIdRef.current !== detail.id) return;
      if (beforeReload !== syncWorkingRevisionRef.current()) throw new Error("The page changed during reload. Sync again.");
      padHubApplyRef.current = true;
      boardSaveSuspendedRef.current = true;
      try {
        const live = board.saveBoard({ assembleInk: false });
        const pageWidth = annotateFrameWidthFromElements(doc.board.elements as {
          width?: number;
          customData?: { lcMdInkFrame?: boolean } | null;
        }[]);
        if (pageWidth != null && pageWidth !== annotatePageWidthRef.current) {
          annotatePageWidthRef.current = pageWidth;
          setAnnotatePageWidth(pageWidth);
          annotateHeightRef.current = null;
          setAnnotateHeight(null);
        }
        board.restoreBoard(hubReloadDocumentElements(doc.board.elements, live.elements),
          hubReloadAppState(live.appState, doc.board.appState), {
          skipFit: true,
          files: doc.board.files,
          inkPalettes: doc.board.inkPalettes,
        });
        await restoreInk(board, annotateDocKey(doc.id), doc.board);
        board.syncDocumentScrollBounds();
        agentMessagesRef.current = restoreAgentMessages(doc.agent ?? []);
        setAgentMessages(agentMessagesRef.current);
        setAnnotateFootnotesRaw(doc.footnotes ?? []);
        annotateFootnotesRef.current = doc.footnotes ?? [];
        const source = annotateSourceRef.current;
        if (source && !isBinaryDocType(doc.docType) && doc.source !== source.text) {
          setAnnotateSource({ ...source, text: doc.source });
        }
        board.armReadingScroll();
        const inkMix = boardInkMix(board);
        lastEditSeqHashRef.current = sceneFingerprint(board.getElements(), inkMix);
        lastEditSeqMarksRef.current = footnoteRevision(annotateFootnotesRef.current);
      } finally {
        padHubApplyRef.current = false;
        boardSaveSuspendedRef.current = false;
      }
    };
  };

  const listenPadHubWindow = ({
    closeTab, setNotice, problemRef, dirtyRef, lastEditSeqHashRef, padHubApplyRef, loadProblem,
  }: WindowContext) => {
    const onHub = (event: Event) => {
      const detail = (event as CustomEvent<PadHubWindowDetail>).detail;
      if (!detail) return;
      if (detail.op === "close") {
        if (detail.kind === "whiteboard" && whiteboardNotebookIdRef.current === detail.id) {
          closeTab(tab.id);
        }
        if (detail.kind === "annotate" && annotateDocIdRef.current === detail.id) {
          closeTab(tab.id);
        }
        if (detail.kind === "problem") {
          const current = problemRef.current;
          if (current && !isLocalPad(current) && problemPadId(current.dataset, current.task_id) === detail.id) {
            closeTab(tab.id);
          }
        }
        return;
      }
      // A Sync tap reloads the open pad itself when it ends. It also fires
      // this event as it writes the open book, and reloading here as well
      // bumped the ink revision under the walk's own guard: every Sync of an
      // open PDF failed with "The page changed during sync (ink)".
      if (syncWalkActiveRef.current) return;
      if (detail.kind === "problem") {
        const current = problemRef.current;
        if (!current || isLocalPad(current)) return;
        if (problemPadId(current.dataset, current.task_id) !== detail.id) return;
        const board = boardRef.current;
        if (dirtyRef.current || (board && lastEditSeqHashRef.current !==
            sceneFingerprint(board.getElements(), boardInkMix(board)))) return;
        padHubApplyRef.current = true;
        void loadProblem(current.task_id, { dataset: current.dataset }, {
          tabId: tab.id,
          userLoad: false,
        }).finally(() => {
          padHubApplyRef.current = false;
        });
        return;
      }
      // Background delivery must not replace an unsaved live page. Explicit
      // Sync prepares the working copy and awaits the guarded reload itself.
      const board = boardRef.current;
      if (dirtyRef.current || (board && lastEditSeqHashRef.current !==
          sceneFingerprint(board.getElements(), boardInkMix(board)))) return;
      void applyHubReloadRef.current(detail).catch(() => {
        setNotice("The page changed during sync. Tap Sync to try again.");
      });
    };
    window.addEventListener(PAD_HUB_WINDOW_EVENT, onHub);
    return () => window.removeEventListener(PAD_HUB_WINDOW_EVENT, onHub);
  };

  return {
    walkReport, padEditSeq, bumpPadEdit, hubSyncTapRef, onHubSync, hubSyncWindowPill,
    hubSyncHostRef, lifecycleSyncOptions, syncWorkingRevisionRef, syncPreparedRevisionRef,
    applyHubReloadRef, trackBookPass, trackHubSyncWindowPill, createHubSyncHost,
    bindSyncWorkingRevision, bindHubReload, listenPadHubWindow,
  };
}
